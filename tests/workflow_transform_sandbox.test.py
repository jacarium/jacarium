#!/usr/bin/env python3
"""
Guards the sandbox around backend/workflow_executor.py's execute_javascript
(the "transform" node of POST /api/workflow/execute).

THE BUG: the transform node's user-written JavaScript was written verbatim into
a temp .js file and executed with plain `node`. That gave the snippet full
require('child_process') / fs / net / process.env access on the machine running
the backend. Workflows are synced between machines through the central server,
so a hostile snippet in a synced workflow became remote code execution the moment
the recipient clicked Run.

THE FIX: two independent containment layers.
  1. Process level - the child runs under Node's permission model
     (`--permission`, or `--experimental-permission` on Node 20-22.12) with read
     access granted only to the static wrapper script, so fs / child_process /
     worker_threads / addons are denied for the whole process regardless of what
     the JS does; a minimal environment (PATH only) so there are no secrets to
     read; and `--disallow-code-generation-from-strings` so eval / new Function
     in the host realm (the classic vm escape) throw.
  2. Realm level - inside the child the snippet runs through the built-in `vm`
     module in a context created from Object.create(null): no require, process,
     console, timers or any host object; the input is JSON-parsed INSIDE the
     context so no host-realm object is ever handed to the snippet; code
     generation from strings is disabled for the context; synchronous execution
     is bounded by a vm timeout as well as the subprocess timeout.
  The wrapper is a static script - user code and input reach it over stdin as
  JSON, so Python never interpolates user code into executable source.

What this test proves:
  Part A (contract preserved): the legitimate transform contract still works -
    string / array / object reshaping, arithmetic, `console.log` debugging
    statements tolerated, `context.input` compatibility, null input, no-return,
    error and syntax-error surfacing - and a full execute_workflow() run with a
    transform node between BeginPlay and Result yields the right value.
  Part B (containment): require, process.env (with a canary secret in the parent
    environment), constructor-chain escapes, new Function / eval, globalThis,
    Error.prepareStackTrace and an infinite loop all fail to leak anything or are
    cut off.
  Part C (process layer): a script run with exactly the flags/env the executor
    uses cannot read files, write files, spawn processes, start worker threads,
    or see the canary env var - i.e. even a hypothetical vm escape gets nothing.

Self-contained, no test framework: run directly with the backend's own venv
interpreter (see tests/run-all.sh). Needs `node` on PATH, like the executor.

  backend/venv/bin/python tests/workflow_transform_sandbox.test.py

Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BACKEND = os.path.join(REPO, 'backend')
sys.path.insert(0, BACKEND)

if shutil.which('node') is None:
    print('node not found on PATH (the workflow executor shells out to it).')
    sys.exit(1)

try:
    import flask  # noqa: F401
except ImportError:
    print('Missing dependency "flask" (backend/workflow_executor.py imports it).')
    print('Run this test with the backend venv: backend/venv/bin/python tests/workflow_transform_sandbox.test.py')
    sys.exit(1)

# Canary: must never be visible to a snippet or to the sandboxed child.
CANARY = 'canary-secret-value-do-not-leak'
os.environ['WORKFLOW_SANDBOX_TEST_CANARY'] = CANARY

import workflow_executor as we  # noqa: E402

results = []


def check(name, passed, detail=''):
    results.append((name, passed))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


def run(code, inp):
    """Returns ('ok', value) or ('err', message)."""
    try:
        return ('ok', we.execute_javascript(code, {'input': inp}))
    except Exception as e:  # noqa: BLE001 - the executor wraps everything in Exception
        return ('err', str(e))


flag = we._node_permission_flag()
print(f'node: {subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()}  permission flag: {flag}')

# ---------------------------------------------------------------------------
# Part A - legitimate transform contract preserved
# ---------------------------------------------------------------------------
print('\n--- Part A: legitimate transforms ---')
check('string transform', run('return input.toUpperCase()', 'hello') == ('ok', 'HELLO'))
check('array transform', run('return input.map(x => x * 2)', [1, 2, 3]) == ('ok', [2, 4, 6]))
check('JSON reshape',
      run('return { n: input.user.name, c: input.items.length }', {'user': {'name': 'a'}, 'items': [1, 2]})
      == ('ok', {'n': 'a', 'c': 2}))
check('arithmetic', run('return input * 2 + 1', 20) == ('ok', 41))
check('string split/trim/filter',
      run('return input.split(",").map(s => s.trim()).filter(Boolean)', ' a, b ,,c') == ('ok', ['a', 'b', 'c']))
check('Object/Math/JSON intrinsics available',
      run('return JSON.stringify(Object.keys(input).sort()) + Math.max(...input.v)', {'v': [1, 9, 3], 'a': 1})
      == ('ok', '["a","v"]9'))
check('console.log in snippet is tolerated', run('console.log("dbg", input); return input + 1', 1) == ('ok', 2))
check('context.input compatibility', run('return context.input + "!"', 'x') == ('ok', 'x!'))
check('null input', run('return input === null', None) == ('ok', True))
check('no return -> None', run('const y = 1;', 1) == ('ok', None))
status, msg = run('throw new Error("boom")', 1)
check('snippet error surfaces', status == 'err' and 'boom' in msg, msg[:80])
status, msg = run('return (', 1)
check('syntax error surfaces', status == 'err', msg[:80])

workflow = {
    'nodes': [
        {'id': 'b', 'type': 'beginplay', 'data': {'inputs': {'name': {}}}},
        {'id': 't', 'type': 'transform', 'data': {'code': 'return "Hi " + input.toUpperCase()'}},
        {'id': 'r', 'type': 'result', 'data': {}},
    ],
    'edges': [
        {'source': 'b', 'target': 't', 'type': 'execution', 'sourceHandle': 'exec-out', 'targetHandle': 'exec-in'},
        {'source': 'b', 'target': 't', 'type': 'data', 'sourceHandle': 'output-name', 'targetHandle': 'data-in'},
        {'source': 't', 'target': 'r', 'type': 'execution', 'sourceHandle': 'exec-out', 'targetHandle': 'exec-in'},
        {'source': 't', 'target': 'r', 'type': 'data', 'sourceHandle': 'data-out', 'targetHandle': 'data-in'},
    ],
}
try:
    wf_result = we.execute_workflow(workflow, {'name': 'bob'})
except Exception as e:  # noqa: BLE001
    wf_result = f'error: {e}'
check('execute_workflow with a transform node', wf_result == 'Hi BOB', str(wf_result)[:80])

# ---------------------------------------------------------------------------
# Part B - realm-level containment
# ---------------------------------------------------------------------------
print('\n--- Part B: hostile snippets ---')
hostile = {
    'require(fs)': 'return require("fs").readFileSync("/etc/hosts", "utf8")',
    'process.env canary': 'return process.env.WORKFLOW_SANDBOX_TEST_CANARY',
    'this.constructor.constructor escape':
        'return this.constructor.constructor("return process")().env.WORKFLOW_SANDBOX_TEST_CANARY',
    'Object constructor escape': 'return ({}).constructor.constructor("return process")().pid',
    'new Function': 'return new Function("return typeof process")()',
    'eval': 'return eval("typeof process")',
    'globalThis.process': 'return typeof globalThis.process',
    'Error.prepareStackTrace getThis':
        'Error.prepareStackTrace = (e, cs) => cs; const g = new Error().stack[0].getThis(); '
        'return g && g.process ? "LEAK" : "none"',
    'infinite loop is cut off': 'while (true) {}',
}
for name, code in hostile.items():
    status, val = run(code, 1)
    serialized = json.dumps(val)
    leaked = (
        CANARY in serialized
        or 'LEAK' in serialized
        or (status == 'ok' and val not in (None, 'undefined', 'none'))
    )
    check(f'hostile: {name}', not leaked, f'{status}: {str(val)[:70]}')

# ---------------------------------------------------------------------------
# Part C - process-level containment (what a vm escape would get)
# ---------------------------------------------------------------------------
print('\n--- Part C: process layer ---')
probe = r"""
const out = {};
const tries = {
  fsRead: () => require('fs').readFileSync('/etc/hosts', 'utf8').slice(0, 5),
  fsWrite: () => require('fs').writeFileSync(require('os').tmpdir() + '/sandbox-probe.txt', 'x'),
  child: () => require('child_process').execSync('echo pwned').toString(),
  worker: () => new (require('worker_threads').Worker)('1', { eval: true }) && 'ok',
  canary: () => process.env.WORKFLOW_SANDBOX_TEST_CANARY || 'absent',
  newFunction: () => new Function('return 1')(),
};
for (const [k, f] of Object.entries(tries)) {
  try { out[k] = 'ALLOWED:' + String(f()); } catch (e) { out[k] = 'DENIED:' + (e.code || e.message); }
}
process.stdout.write(JSON.stringify(out));
"""
with tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False) as f:
    f.write(probe)
    probe_path = os.path.realpath(f.name)
try:
    cmd = ['node']
    if flag:
        cmd += [flag, f'--allow-fs-read={probe_path}']
    cmd += ['--disallow-code-generation-from-strings', probe_path]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15, env=we._sandbox_child_env())
    try:
        out = json.loads(proc.stdout)
    except ValueError:
        out = {'_error': proc.stderr[:200]}
finally:
    os.unlink(probe_path)

if flag is None:
    check('process layer: permission model available', False,
          'this node has no permission model (Node < 20) - only vm-level containment applies')
else:
    check('process layer: fs read denied', str(out.get('fsRead', '')).startswith('DENIED'), out.get('fsRead'))
    check('process layer: fs write denied', str(out.get('fsWrite', '')).startswith('DENIED'), out.get('fsWrite'))
    check('process layer: child_process denied', str(out.get('child', '')).startswith('DENIED'), out.get('child'))
    check('process layer: worker_threads denied', str(out.get('worker', '')).startswith('DENIED'), out.get('worker'))
check('process layer: parent env canary not inherited', out.get('canary') == 'ALLOWED:absent', out.get('canary'))
check('process layer: host-realm new Function disallowed', str(out.get('newFunction', '')).startswith('DENIED'),
      out.get('newFunction'))

# ---------------------------------------------------------------------------
failed = [name for name, passed in results if not passed]
print(f'\nSUMMARY: {len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
