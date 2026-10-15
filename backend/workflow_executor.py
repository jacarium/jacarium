"""
Workflow Executor Module
Executes workflow definitions with nodes and edges
"""
from flask import Blueprint, request, jsonify
import json
import re
import requests as http_requests
import subprocess
import sys
import tempfile
import threading
import os

workflow_executor = Blueprint('workflow_executor', __name__)


# ---------------------------------------------------------------------------
# Transform-node JavaScript sandbox
# ---------------------------------------------------------------------------
# Transform nodes carry user-written JS, and workflows are synced between
# machines - so a snippet may have been authored by someone else. Previously
# the snippet was written verbatim into a .js file and run with plain `node`,
# i.e. with full require('child_process') / fs / net access: remote code
# execution for anyone who could get a workflow onto this machine.
#
# The snippet is now executed with two independent layers of containment:
#
#  1. Process level - Node's permission model (`--permission`, or
#     `--experimental-permission` on older Node) with read access granted
#     ONLY to the wrapper script itself. That denies fs read/write,
#     child_process, worker_threads, native addons and WASI for the whole
#     process, no matter what the JS does. The child also gets a minimal
#     environment (PATH only) so there are no secrets to read, and
#     `--disallow-code-generation-from-strings` blocks eval/new Function in
#     the host realm (the classic `vm` escape route).
#
#  2. Realm level - inside that process the snippet runs via the built-in
#     `vm` module in a fresh context created from Object.create(null): no
#     `require`, `process`, `globalThis` of the host, `console`, timers or
#     any other host object. The input is JSON-parsed INSIDE the context so
#     no host-realm object is ever handed to the snippet, code generation
#     from strings is disabled for the context, and synchronous execution is
#     bounded by a vm timeout (in addition to the subprocess timeout).
#
# The wrapper is a static script; user code and input reach it over stdin as
# JSON, so nothing is ever interpolated into executable source by Python.
#
# Residual risk: Node's `vm` is documented as not being a security boundary
# on its own, and the permission model has no network permission - so a
# snippet that found a fresh vm escape could still open sockets from the
# child process. It could not read files, spawn processes or see env vars.
# True isolation would need isolated-vm / a separate container.

_NODE_SANDBOX_WRAPPER = r"""'use strict';
const vm = require('node:vm');

function fail(message, code) {
  process.stderr.write(String(message));
  process.exit(code || 1);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('error', (err) => fail('failed to read payload: ' + err.message, 2));
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    fail('invalid payload: ' + err.message, 2);
    return;
  }

  const timeoutMs = Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : 4000;
  // JSON text of the context, embedded as a JS string literal so the context
  // is materialized by the SANDBOX's JSON.parse (no host objects leak in).
  const contextLiteral = JSON.stringify(JSON.stringify(payload.context === undefined ? null : payload.context));

  // Empty-prototype global: the snippet sees only ECMAScript intrinsics.
  const sandbox = Object.create(null);
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

  // Same contract as before: `input` (and `context`) in scope, the snippet
  // is the body of a function whose return value is the node output.
  // console.* is a no-op so debugging statements never break JSON output.
  const source = '(function () {\n'
    + '  const console = { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {}, table() {}, dir() {} };\n'
    + '  const context = JSON.parse(' + contextLiteral + ') || {};\n'
    + '  const input = context.input;\n'
    + '  return (function (input, context) {\n'
    + String(payload.code == null ? '' : payload.code) + '\n'
    + '  })(input, context);\n'
    + '})()';

  let result;
  try {
    result = vm.runInContext(source, sandbox, { timeout: timeoutMs, filename: 'transformation.js' });
  } catch (err) {
    fail(err && err.message ? err.message : String(err), 1);
    return;
  }

  let output;
  try {
    output = JSON.stringify(result === undefined ? null : result);
  } catch (err) {
    fail('result is not JSON-serializable: ' + (err && err.message ? err.message : String(err)), 1);
    return;
  }
  process.stdout.write(output === undefined ? 'null' : output, () => process.exit(0));
});
"""

_node_permission_flag_cache = {}
_node_permission_flag_lock = threading.Lock()


def _node_permission_flag(node_binary='node'):
    """
    Return the flag that enables Node's permission model for this `node`
    (probed once per process from `node --help`): '--permission' on Node
    >= 22.13 / 23.5 / 24, '--experimental-permission' on Node 20-22.12, or
    None when the binary has no permission model at all (< 20), in which
    case only the vm-level containment applies and a warning is logged.
    """
    with _node_permission_flag_lock:
        if node_binary in _node_permission_flag_cache:
            return _node_permission_flag_cache[node_binary]
        flag = None
        try:
            help_text = subprocess.run(
                [node_binary, '--help'],
                capture_output=True,
                text=True,
                timeout=10
            ).stdout or ''
        except Exception as e:
            help_text = ''
            print(f"[Transform] Could not probe node permission flags: {e}")
        if re.search(r'(?<![\w-])--permission\b', help_text):
            flag = '--permission'
        elif re.search(r'(?<![\w-])--experimental-permission\b', help_text):
            flag = '--experimental-permission'
        else:
            print("[Transform] WARNING: this node has no permission model (Node < 20); "
                  "transform snippets run with vm-level containment only. Upgrade Node.")
        _node_permission_flag_cache[node_binary] = flag
        return flag


def _sandbox_child_env():
    """Minimal environment for the sandbox child: no app secrets, just PATH."""
    env = {'PATH': os.environ.get('PATH', '')}
    if sys.platform == 'win32':
        # node.exe needs these to start on Windows
        for key in ('SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP'):
            if key in os.environ:
                env[key] = os.environ[key]
    return env


def execute_javascript(code, context, timeout=5):
    """
    Execute a transform-node JavaScript snippet in a sandboxed Node.js child.

    The snippet is the body of `function (input, context) { ... }`; its
    return value (JSON-serialized) is returned. It cannot access require,
    process, fs, child_process, env vars or any host object - see the
    sandbox notes above.

    Args:
        code: JavaScript code to execute
        context: Dictionary of variables to make available in the code
                 (context.input is exposed as `input`)
        timeout: hard wall-clock limit for the child process, seconds

    Returns:
        The result of the JavaScript execution
    """
    try:
        # Wrapper goes to a temp file (static content, no user code in it).
        # realpath() matters: the permission model compares resolved paths and
        # tempdirs are often behind symlinks (macOS /var -> /private/var).
        with tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False) as f:
            f.write(_NODE_SANDBOX_WRAPPER)
            temp_file = os.path.realpath(f.name)

        try:
            node_binary = 'node'
            permission_flag = _node_permission_flag(node_binary)

            cmd = [node_binary]
            if permission_flag:
                cmd += [permission_flag, f'--allow-fs-read={temp_file}']
            cmd += [
                '--disallow-code-generation-from-strings',
                '--max-old-space-size=256',
                temp_file
            ]

            payload = json.dumps({
                'code': code if code is not None else '',
                'context': context,
                # leave headroom below the subprocess timeout so a runaway
                # loop is reported as a script timeout, not a killed child
                'timeoutMs': max(500, int(timeout * 1000) - 1000)
            })

            result = subprocess.run(
                cmd,
                input=payload,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=_sandbox_child_env()
            )

            if result.returncode != 0:
                raise Exception(f"JavaScript execution failed: {result.stderr.strip()}")

            # Parse JSON output
            output = result.stdout.strip()
            if output:
                return json.loads(output)
            return None

        finally:
            # Clean up temp file
            os.unlink(temp_file)

    except subprocess.TimeoutExpired:
        raise Exception(f"JavaScript execution timeout ({timeout}s limit)")
    except Exception as e:
        raise Exception(f"JavaScript execution error: {str(e)}")


def build_execution_graph(nodes, edges):
    """
    Build execution graph from nodes and edges
    Returns dict mapping node IDs to their outgoing connections
    """
    exec_graph = {}  # Execution flow (exec-in/exec-out)
    data_graph = {}  # Data flow (data-in/data-out)

    for node in nodes:
        exec_graph[node['id']] = []
        data_graph[node['id']] = []

    for edge in edges:
        source = edge['source']
        target = edge['target']
        source_handle = edge.get('sourceHandle', '')
        target_handle = edge.get('targetHandle', '')
        edge_type = edge.get('type', '')

        # Execution edges: explicit type='execution' OR both handles contain 'exec' OR special control flow handles
        is_execution_edge = (
            edge_type == 'execution' or
            ('exec' in source_handle and 'exec' in target_handle) or
            source_handle in ['loop-body', 'completed', 'true', 'false'] or
            target_handle.startswith('exec-')
        )

        if is_execution_edge:
            exec_graph[source].append({
                'target': target,
                'sourceHandle': source_handle,
                'targetHandle': target_handle
            })
        # Data edges (purple handles)
        else:
            data_graph[source].append({
                'target': target,
                'sourceHandle': source_handle,
                'targetHandle': target_handle
            })

    return exec_graph, data_graph


def get_node_output_value(node_id, source_handle, node_outputs, nodes_by_id):
    """
    Get the output value from a node given the source handle

    Args:
        node_id: The node ID
        source_handle: The handle ID (e.g., 'data-out', 'input-myfield')
        node_outputs: Dict of node outputs
        nodes_by_id: Dict mapping node IDs to node definitions

    Returns:
        The value from that specific output handle
    """
    if node_id not in node_outputs:
        print(f"[Executor] Node {node_id} not in outputs yet")
        return None

    node = nodes_by_id.get(node_id)
    output_value = node_outputs[node_id]

    print(f"[Executor] Getting output from {node.get('type')} node {node_id}, handle={source_handle}, value={output_value}")

    # For BeginPlay nodes with named outputs, extract the specific field
    if node and node.get('type') == 'beginplay' and source_handle:
        # Handle both old format (input-) and new format (output-)
        field_name = None
        if source_handle.startswith('output-'):
            field_name = source_handle[7:]  # Remove 'output-' prefix
        elif source_handle.startswith('input-'):
            field_name = source_handle[6:]  # Remove 'input-' prefix (backwards compatibility)

        if field_name and isinstance(output_value, dict):
            extracted = output_value.get(field_name)
            print(f"[Executor] Extracted field '{field_name}' from BeginPlay: {extracted}")
            return extracted
        elif field_name:
            print(f"[Executor] BeginPlay output is not a dict: {type(output_value)}")

    # For other nodes, return the whole output
    return output_value


def execute_node(node, inputs_data, node_outputs, edges, nodes_by_id, env_vars=None, workflow_variables=None):
    """
    Execute a single node and return its output

    Args:
        node: The node definition
        inputs_data: Input data for BeginPlay nodes
        node_outputs: Dict of already computed node outputs
        edges: List of edges in the workflow
        nodes_by_id: Dict mapping node IDs to node definitions
        env_vars: Dict of environment variables
        workflow_variables: Dict of stored workflow variables

    Returns:
        The node's output value
    """
    if env_vars is None:
        env_vars = {}
    if workflow_variables is None:
        workflow_variables = {}
    node_type = node.get('type')
    node_data = node.get('data', {})
    node_id = node.get('id')

    try:
        # BeginPlay node - return inputs (either from connected nodes or from inputs_data)
        if node_type == 'beginplay':
            print(f"[Executor] BeginPlay executing with inputs_data: {inputs_data}")

            # Check if there are connected input handles (for testing in workflow editor)
            result = {}
            data_deps = find_data_dependencies(node_id, edges)

            # Get node's defined inputs
            node_inputs = node_data.get('inputs', {})
            print(f"[Executor] BeginPlay has {len(node_inputs)} defined inputs: {list(node_inputs.keys())}")
            print(f"[Executor] BeginPlay has {len(data_deps)} data dependencies: {data_deps}")

            for input_name in node_inputs.keys():
                # Check if user provided a value via inputs_data
                user_value = inputs_data.get(input_name) if inputs_data else None

                # Check if there's a connected edge for this input
                connected_value = None
                for dep in data_deps:
                    if dep['targetHandle'] == f'input-{input_name}':
                        # Try to get value from node_outputs first
                        connected_value = get_node_output_value(
                            dep['source'],
                            dep['sourceHandle'],
                            node_outputs,
                            nodes_by_id
                        )

                        # If not in outputs yet, directly read from variable nodes
                        if connected_value is None:
                            source_node = nodes_by_id.get(dep['source'])
                            print(f"[Executor] BeginPlay trying to read from source node {dep['source']}: {source_node is not None}")
                            if source_node:
                                source_type = source_node.get('type')
                                source_data = source_node.get('data', {})
                                print(f"[Executor] Source node type: {source_type}, data keys: {list(source_data.keys())}")

                                # Read values directly from variable nodes
                                if source_type in ['string', 'text']:
                                    connected_value = source_data.get('value', '')
                                    # Apply env var replacement
                                    connected_value = replace_env_variables(connected_value, env_vars)
                                    print(f"[Executor] Read string/text value: '{connected_value}'")
                                elif source_type == 'integer':
                                    connected_value = source_data.get('value', 0)
                                    print(f"[Executor] Read integer value: {connected_value}")
                                elif source_type == 'boolean':
                                    connected_value = source_data.get('value', False)
                                    print(f"[Executor] Read boolean value: {connected_value}")
                                elif source_type == 'array':
                                    connected_value = source_data.get('value', [])
                                    print(f"[Executor] Read array value: {connected_value}")
                                elif source_type == 'object':
                                    connected_value = source_data.get('value', {})
                                    print(f"[Executor] Read object value: {connected_value}")
                                else:
                                    print(f"[Executor] Unknown node type: {source_type}")

                                if connected_value is not None:
                                    print(f"[Executor] BeginPlay input '{input_name}' read directly from {source_type} node: {connected_value}")
                                    # Store in outputs for future use
                                    node_outputs[dep['source']] = connected_value
                            else:
                                print(f"[Executor] Source node {dep['source']} not found in nodes_by_id")

                        if connected_value is not None:
                            print(f"[Executor] BeginPlay input '{input_name}' connected to value: {connected_value}")
                        break

                # Priority: user-provided value (if exists) > connected value > None
                if user_value is not None:
                    result[input_name] = user_value
                    print(f"[Executor] BeginPlay input '{input_name}' from user input: {user_value}")
                elif connected_value is not None:
                    result[input_name] = connected_value
                    print(f"[Executor] BeginPlay input '{input_name}' using connected value: {connected_value}")
                else:
                    result[input_name] = None
                    print(f"[Executor] BeginPlay input '{input_name}' has no value")

            print(f"[Executor] BeginPlay result: {result}")
            return result if result else {}

        # Variable nodes - return their value (with env var replacement for strings)
        elif node_type in ['string', 'text']:
            value = node_data.get('value', '')
            return replace_env_variables(value, env_vars) if env_vars else value
        elif node_type in ['integer', 'boolean', 'object', 'array']:
            return node_data.get('value')

        # Transform node - execute JavaScript code (supports both 'transform' and 'transformation' for compatibility)
        elif node_type in ['transform', 'transformation']:
            code = node_data.get('code', '')
            # Get input data from connected nodes
            input_value = None

            # Find which node is connected to this transform node's data-in
            data_deps = find_data_dependencies(node_id, edges)
            for dep in data_deps:
                if dep['targetHandle'] == 'data-in':
                    input_value = get_node_output_value(
                        dep['source'],
                        dep['sourceHandle'],
                        node_outputs,
                        nodes_by_id
                    )
                    break

            # Execute JavaScript code using Node.js
            try:
                context = {'input': input_value}
                result = execute_javascript(code, context)
                return result
            except Exception as e:
                print(f"[Transform] Error executing code: {code}")
                print(f"[Transform] Error: {str(e)}")
                raise Exception(f"Transform execution error: {str(e)}")

        # REST API node (supports both 'restapi' and 'http' for compatibility)
        elif node_type in ['restapi', 'http']:
            url = node_data.get('url', '')
            method = node_data.get('method', 'GET')
            headers_str = node_data.get('headers', '{}')
            body_str = node_data.get('body', '')

            # Parse headers
            try:
                headers = json.loads(headers_str) if headers_str else {}
            except:
                headers = {}

            # Make request - guarded (backend/safe_url.py): the URL may have
            # arrived in a synced workflow, so loopback/link-local (cloud
            # metadata)/unspecified targets are always rejected; intranet
            # (RFC1918) hosts are allowed by default because users target
            # them legitimately (JACARIUM_WORKFLOW_ALLOW_PRIVATE_URLS=0
            # disables); every redirect hop is re-validated and the body is
            # capped at 10 MB.
            try:
                if method not in ('GET', 'POST', 'PUT', 'DELETE', 'PATCH'):
                    raise Exception(f"Unsupported HTTP method: {method}")
                from safe_url import safe_request, workflow_private_urls_allowed
                response = safe_request(
                    method, url, headers=headers,
                    data=body_str if method in ('POST', 'PUT', 'PATCH') else None,
                    timeout=10, allow_private=workflow_private_urls_allowed())

                # Try to parse JSON response
                try:
                    return response.json()
                except Exception:
                    return response.text
            except Exception as e:
                raise Exception(f"REST API error: {str(e)}")

        # Result node - return the input data
        elif node_type == 'result':
            # Get input from connected data source
            data_deps = find_data_dependencies(node_id, edges)
            for dep in data_deps:
                if dep['targetHandle'] == 'data-in':
                    return get_node_output_value(
                        dep['source'],
                        dep['sourceHandle'],
                        node_outputs,
                        nodes_by_id
                    )
            return None

        # Visualizer node - pass through the data
        elif node_type == 'visualizer':
            data_deps = find_data_dependencies(node_id, edges)
            for dep in data_deps:
                if dep['targetHandle'] == 'data-in':
                    return get_node_output_value(
                        dep['source'],
                        dep['sourceHandle'],
                        node_outputs,
                        nodes_by_id
                    )
            return None

        # Storage node - store data in workflow variables
        elif node_type == 'storage':
            variable_name = node_data.get('variableName', 'data')
            data_deps = find_data_dependencies(node_id, edges)

            stored_value = None
            for dep in data_deps:
                stored_value = get_node_output_value(
                    dep['source'],
                    dep['sourceHandle'],
                    node_outputs,
                    nodes_by_id
                )
                break

            # Store in workflow variables
            if stored_value is not None:
                workflow_variables[variable_name] = stored_value
                print(f"[Executor] Stored data as '{variable_name}': {stored_value}")

            return stored_value

        # Variable Reference node - get data from workflow variables
        elif node_type == 'variablereference':
            variable_name = node_data.get('variableName', 'data')
            value = workflow_variables.get(variable_name)
            print(f"[Executor] Retrieved variable '{variable_name}': {value}")
            return value

        # Sequence node - execute multiple branches
        elif node_type == 'sequence':
            # For sequence, we don't produce data output, just control flow
            return None

        # Branch node - conditional execution
        elif node_type == 'branch':
            # Get condition value
            condition = node_data.get('condition', False)
            # Branch doesn't produce data, just controls execution flow
            return condition

        # Delay node - pause execution
        elif node_type == 'delay':
            import time
            delay_ms = int(node_data.get('delay', 1000))
            input_value = None

            # Check for data connections
            dependencies = find_data_dependencies(node['id'], edges)
            for dep in dependencies:
                if dep['targetHandle'] == 'delay-in':
                    val = get_node_output_value(dep['source'], dep['sourceHandle'], node_outputs, nodes_by_id)
                    if val is not None:
                        delay_ms = int(val)
                elif dep['targetHandle'] == 'in':
                    input_value = get_node_output_value(dep['source'], dep['sourceHandle'], node_outputs, nodes_by_id)

            print(f"[Executor] Delaying for {delay_ms}ms")
            time.sleep(delay_ms / 1000.0)
            return input_value

        # For Loop node - iterate over items
        elif node_type == 'forloop':
            array_data = []
            iterations = int(node_data.get('iterations', 3))

            # Check for data connections
            dependencies = find_data_dependencies(node['id'], edges)
            for dep in dependencies:
                if dep['targetHandle'] == 'array-in':
                    arr = get_node_output_value(dep['source'], dep['sourceHandle'], node_outputs, nodes_by_id)
                    if isinstance(arr, list):
                        array_data = arr
                elif dep['targetHandle'] == 'iterations-in':
                    val = get_node_output_value(dep['source'], dep['sourceHandle'], node_outputs, nodes_by_id)
                    if val is not None:
                        iterations = int(val)

            # Use array if provided, otherwise generate range
            if not array_data:
                array_data = list(range(iterations))

            return {'items': array_data, 'count': len(array_data)}

        # Make Array node - collect items into an array
        elif node_type == 'makearray':
            items = []

            # Collect all items from data inputs
            dependencies = find_data_dependencies(node['id'], edges)
            for dep in dependencies:
                value = get_node_output_value(dep['source'], dep['sourceHandle'], node_outputs, nodes_by_id)
                if value is not None:
                    items.append(value)

            return items

        # Switch node - multi-case branching
        elif node_type == 'switch':
            input_value = None

            # Get input value
            dependencies = find_data_dependencies(node['id'], edges)
            for dep in dependencies:
                if dep['targetHandle'] == 'value-in':
                    input_value = get_node_output_value(dep['source'], dep['sourceHandle'], node_outputs, nodes_by_id)
                    break

            cases = node_data.get('cases', [])
            default_case = node_data.get('default', None)

            # Find matching case
            for case_item in cases:
                if str(input_value) == str(case_item.get('value')):
                    return {'matched': case_item.get('value'), 'case': case_item.get('value')}

            return {'matched': default_case, 'case': 'default'}

        # For other nodes, return None
        else:
            return None

    except Exception as e:
        raise Exception(f"Error executing {node_type} node: {str(e)}")


def find_data_dependencies(node_id, edges):
    """Find all nodes that provide data inputs to this node"""
    dependencies = []
    for edge in edges:
        # Check if this is a data edge (not execution edge)
        target_handle = edge.get('targetHandle', '')
        edge_type = edge.get('type', '')

        # Data edge if: type='data' OR handle doesn't contain 'exec'
        is_data_edge = edge_type == 'data' or ('exec' not in target_handle and target_handle != '')

        if edge['target'] == node_id and is_data_edge:
            dependencies.append({
                'source': edge['source'],
                'sourceHandle': edge.get('sourceHandle', ''),
                'targetHandle': edge.get('targetHandle', '')
            })
    return dependencies


def replace_env_variables(text, env_vars):
    """Replace {{VAR}} placeholders with environment variable values"""
    if not isinstance(text, str):
        return text

    import re
    def replacer(match):
        var_name = match.group(1).strip()
        return env_vars.get(var_name, match.group(0))

    return re.sub(r'\{\{([^}]+)\}\}', replacer, text)


def execute_workflow(workflow, inputs, env_vars=None):
    """
    Execute a workflow with given inputs

    Args:
        workflow: Workflow definition with nodes and edges
        inputs: Dict of input values for BeginPlay node
        env_vars: Dict of environment variables for {{VAR}} replacement

    Returns:
        Result from Result node
    """
    if env_vars is None:
        env_vars = {}

    # Workflow variables storage (for Storage nodes)
    workflow_variables = {}
    nodes = workflow.get('nodes', [])
    edges = workflow.get('edges', [])

    if not nodes:
        raise Exception("Workflow has no nodes")

    # Build execution graph
    exec_graph, data_graph = build_execution_graph(nodes, edges)

    # Find BeginPlay node
    begin_node = None
    result_node = None
    nodes_by_id = {}

    for node in nodes:
        nodes_by_id[node['id']] = node
        if node['type'] == 'beginplay':
            begin_node = node
        elif node['type'] == 'result':
            result_node = node

    if not begin_node:
        raise Exception("Workflow must have a BeginPlay node")

    if not result_node:
        raise Exception("Workflow must have a Result node")

    # Track node outputs
    node_outputs = {}

    # Execute nodes in topological order following execution flow
    def execute_from_node(node_id, depth=0, loop_item_data=None):
        """Recursively execute nodes following execution flow"""
        if depth > 100:  # Prevent infinite loops
            raise Exception("Execution depth limit exceeded - possible infinite loop")

        node = nodes_by_id.get(node_id)
        if not node:
            print(f"[Executor] Node {node_id} not found!")
            return

        print(f"[Executor] Executing node {node_id} (type: {node.get('type')}, depth: {depth})")

        # Get data dependencies first
        data_deps = find_data_dependencies(node_id, edges)
        for dep in data_deps:
            dep_id = dep['source']
            if dep_id not in node_outputs:
                # Execute data dependency if not already executed
                dep_node = nodes_by_id.get(dep_id)
                if dep_node:
                    node_outputs[dep_id] = execute_node(dep_node, inputs, node_outputs, edges, nodes_by_id, env_vars, workflow_variables)

        # Execute current node
        if node_id not in node_outputs:
            node_outputs[node_id] = execute_node(node, inputs, node_outputs, edges, nodes_by_id, env_vars, workflow_variables)

        # Special handling for forloop nodes
        if node.get('type') == 'forloop':
            output = node_outputs[node_id]
            print(f"[Executor] Forloop node {node_id} output: {output}")
            if output and 'items' in output:
                # Find the loop body edge
                loop_body_edges = [e for e in exec_graph.get(node_id, []) if e.get('sourceHandle') == 'loop-body']

                if loop_body_edges:
                    loop_body_target = loop_body_edges[0]['target']
                    print(f"[Executor] Executing forloop {node_id} for {output['count']} iterations")

                    # Execute loop body for each item
                    for i, item in enumerate(output['items']):
                        print(f"[Executor]   Loop iteration {i + 1}/{output['count']}: {item}")
                        # Execute the loop body chain with the current item
                        execute_loop_body(loop_body_target, item, depth + 1)

                # Continue with completed edge (after all iterations)
                completed_edges = [e for e in exec_graph.get(node_id, []) if e.get('sourceHandle') == 'completed']
                for next_edge in completed_edges:
                    execute_from_node(next_edge['target'], depth + 1)
            else:
                # No loop body, just continue normally
                for next_edge in exec_graph.get(node_id, []):
                    execute_from_node(next_edge['target'], depth + 1)
        else:
            # Follow execution edges to next nodes
            next_edges = exec_graph.get(node_id, [])
            print(f"[Executor] Node {node_id} has {len(next_edges)} execution edges")
            for next_edge in next_edges:
                print(f"[Executor]   Following edge to {next_edge['target']}")
                execute_from_node(next_edge['target'], depth + 1)

    def execute_loop_body(node_id, item_data, depth=0):
        """Execute a loop body chain with the current loop item"""
        if depth > 100:
            raise Exception("Execution depth limit exceeded - possible infinite loop")

        node = nodes_by_id.get(node_id)
        if not node:
            return

        # Get data dependencies
        data_deps = find_data_dependencies(node_id, edges)
        for dep in data_deps:
            dep_id = dep['source']
            if dep_id not in node_outputs:
                dep_node = nodes_by_id.get(dep_id)
                if dep_node:
                    node_outputs[dep_id] = execute_node(dep_node, inputs, node_outputs, edges, nodes_by_id, env_vars, workflow_variables)

        # Execute current node with loop item data
        # For nodes that need the loop item, they'll get it from the forloop node output
        if node_id not in node_outputs or node.get('type') in ['delay', 'visualizer']:
            # Re-execute certain nodes in each iteration
            node_outputs[node_id] = execute_node(node, inputs, node_outputs, edges, nodes_by_id, env_vars, workflow_variables)

        # Follow execution edges
        for next_edge in exec_graph.get(node_id, []):
            execute_loop_body(next_edge['target'], item_data, depth + 1)

    # Start execution from BeginPlay
    execute_from_node(begin_node['id'])

    # Get result from Result node
    if result_node['id'] in node_outputs:
        return node_outputs[result_node['id']]

    # If Result node wasn't reached through execution flow, execute it directly
    result_deps = find_data_dependencies(result_node['id'], edges)
    for dep in result_deps:
        dep_id = dep['source']
        if dep_id not in node_outputs:
            dep_node = nodes_by_id.get(dep_id)
            if dep_node:
                node_outputs[dep_id] = execute_node(dep_node, inputs, node_outputs, edges, nodes_by_id, env_vars, workflow_variables)

    return execute_node(result_node, inputs, node_outputs, edges, nodes_by_id, env_vars, workflow_variables)


@workflow_executor.route('/api/workflow/execute', methods=['POST'])
def execute_workflow_endpoint():
    """
    Execute a workflow

    Expected payload:
    {
        "workflow": {
            "id": 123,
            "title": "My Workflow",
            "nodes": [...],
            "edges": [...]
        },
        "inputs": {
            "input1": "value1",
            "input2": "value2"
        }
    }

    Returns:
    {
        "success": true,
        "result": <workflow result>
    }

    Or on error:
    {
        "success": false,
        "error": "error message"
    }
    """
    try:
        data = request.json
        workflow = data.get('workflow')
        inputs = data.get('inputs', {})
        env_vars = data.get('env_vars', {})

        if not workflow:
            return jsonify({'success': False, 'error': 'Missing workflow'}), 400

        print(f"[Workflow] Executing workflow: {workflow.get('title', 'Untitled')}")
        # Log input NAMES only: values can be credentials, hostnames or
        # pasted data and this line is emitted in every build.
        print(f"[Workflow] Inputs: {list(inputs.keys()) if isinstance(inputs, dict) else type(inputs).__name__}")
        print(f"[Workflow] Environment variables: {list(env_vars.keys())}")
        print(f"[Workflow] Nodes: {len(workflow.get('nodes', []))}")
        print(f"[Workflow] Edges: {workflow.get('edges', [])}")

        # Execute workflow
        result = execute_workflow(workflow, inputs, env_vars)

        # Result may contain SSH output / fetched content - log its shape only.
        try:
            result_size = len(json.dumps(result, default=str))
        except Exception:
            result_size = -1
        print(f"[Workflow] Execution complete. Result: {type(result).__name__} ({result_size} JSON chars)")

        return jsonify({
            'success': True,
            'result': result
        })

    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()
        print(f"[Workflow Error] {error_trace}")

        return jsonify({
            'success': False,
            'error': str(e)
        }), 500
