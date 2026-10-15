import { replaceEnvironmentVariables } from './workflows';
import { getBackendUrl, apiFetch } from './backendUrl';
import { can } from './platform';

// ============================================================================
// Transformation node sandbox
// ============================================================================
// Transformation nodes run user-supplied JavaScript. Workflows are synced
// between machines through the central server, so that code may have been
// written by someone else. It must therefore NOT be evaluated in this
// (renderer) realm, where `window.electronAPI` - the preload bridge to env
// vars, SSH execution, the backend auth token, etc. - is reachable.
//
// Instead the snippet runs inside a dedicated Web Worker built from a blob:
//   - a worker has no DOM, no `window`, and no preload bridge (contextBridge
//     only exposes electronAPI to the window's main world);
//   - before the snippet is evaluated the worker deletes every global that
//     could reach the network, load more code or touch persistent storage
//     (fetch, XMLHttpRequest, WebSocket, importScripts, indexedDB, ...);
//   - data crosses the boundary by structured clone only, and the worker is
//     terminated after each run (or on timeout).
// The legitimate contract is unchanged: the snippet is the body of
// `function (input) { ... }` and its return value becomes the node output.
//
// Environments without Worker/Blob support (e.g. jsdom in tests) fall back to
// a restricted Function with the dangerous globals shadowed - weaker, but
// those environments have no electronAPI bridge to protect anyway.

const TRANSFORMATION_TIMEOUT_MS = 30000;

// Node types with no execution pins: never seeded into the execution queue,
// evaluated on demand when a downstream node pulls their data edge.
const DATA_ONLY_NODE_TYPES = ['variablereference', 'comparison', 'string', 'integer', 'text', 'boolean', 'object', 'array'];

// Freeform annotation nodes (mind-map notes): never executed at all.
const ANNOTATION_NODE_TYPES = ['note', 'idea'];

const TRANSFORMATION_WORKER_SOURCE = `'use strict';
(function () {
  // Members of a [Global] interface are own properties of the global object
  // itself, so deleting them removes them from this realm. The defineProperty
  // afterwards pins the name so user code cannot recreate it via assignment.
  var blocked = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport',
    'RTCPeerConnection', 'importScripts', 'Worker', 'SharedWorker',
    'BroadcastChannel', 'indexedDB', 'caches', 'navigator', 'Notification',
    'showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker'
  ];
  for (var i = 0; i < blocked.length; i++) {
    var name = blocked[i];
    try { delete self[name]; } catch (e) { /* not configurable - pinned below */ }
    try {
      Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false });
    } catch (e) { /* ignore */ }
  }

  function describe(err) {
    return err && err.message ? String(err.message) : String(err);
  }

  function reply(message) {
    self.postMessage(message);
  }

  function replyResult(value) {
    try {
      reply({ ok: true, result: value });
    } catch (cloneError) {
      // Not structured-cloneable (e.g. contains functions): fall back to the
      // JSON projection, which is what the backend executor returns anyway.
      try {
        reply({ ok: true, result: JSON.parse(JSON.stringify(value === undefined ? null : value)) });
      } catch (jsonError) {
        reply({ ok: false, error: 'Transformation returned a value that cannot be serialized: ' + describe(cloneError) });
      }
    }
  }

  self.onmessage = function (event) {
    var data = event.data || {};
    var value;
    try {
      var fn = new Function('input', String(data.code));
      value = fn(data.input);
    } catch (err) {
      reply({ ok: false, error: describe(err) });
      return;
    }
    Promise.resolve(value).then(replyResult, function (err) {
      reply({ ok: false, error: describe(err) });
    });
  };
})();
`;

let transformationWorkerUrl = null;

function getTransformationWorkerUrl() {
  if (!transformationWorkerUrl) {
    transformationWorkerUrl = URL.createObjectURL(
      new Blob([TRANSFORMATION_WORKER_SOURCE], { type: 'text/javascript' })
    );
  }
  return transformationWorkerUrl;
}

function canUseTransformationWorker() {
  return typeof Worker === 'function'
    && typeof Blob === 'function'
    && typeof URL !== 'undefined'
    && typeof URL.createObjectURL === 'function';
}

/** Make sure a value can cross the worker boundary (structured clone). */
function toCloneable(value) {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') {
    try {
      structuredClone(value);
      return value;
    } catch {
      // fall through to the JSON projection
    }
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * Fallback for environments without Worker/Blob (jsdom, SSR): evaluate the
 * snippet in strict mode with the dangerous globals shadowed as parameters
 * bound to undefined. This is NOT a security boundary against hostile code
 * (a Function-constructor chain could still reach the outer realm); it only
 * exists so the executor keeps working where the sandbox worker is
 * unavailable - which is never the Electron renderer.
 */
function runTransformationRestricted(code, inputData) {
  const shadowed = [
    'window', 'self', 'globalThis', 'global', 'document', 'electronAPI',
    'require', 'process', 'module', 'exports', 'fetch', 'XMLHttpRequest',
    'WebSocket', 'importScripts', 'navigator', 'localStorage',
    'sessionStorage', 'indexedDB', 'Function'
  ];
  const fn = new Function('input', ...shadowed, `'use strict';\n${code}`);
  return fn(inputData);
}

/**
 * Run a transformation snippet against `inputData` inside the sandbox
 * worker. Resolves with the snippet's return value (structured-cloned) or
 * rejects with the snippet's error / a timeout.
 */
function runTransformation(code, inputData) {
  if (!canUseTransformationWorker()) {
    return Promise.resolve().then(() => runTransformationRestricted(code, inputData));
  }

  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(getTransformationWorkerUrl());
    } catch (error) {
      reject(new Error(`Transformation sandbox unavailable: ${error.message}`));
      return;
    }

    let settled = false;
    let timer = null;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      worker.terminate();
      settle(value);
    };

    timer = setTimeout(() => {
      finish(reject, new Error(`Transformation timed out after ${TRANSFORMATION_TIMEOUT_MS / 1000}s`));
    }, TRANSFORMATION_TIMEOUT_MS);

    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.ok) {
        finish(resolve, message.result);
      } else {
        finish(reject, new Error(message.error || 'Transformation failed'));
      }
    };
    worker.onerror = (event) => {
      finish(reject, new Error((event && event.message) || 'Transformation failed'));
    };

    try {
      worker.postMessage({ code: String(code), input: toCloneable(inputData) });
    } catch (error) {
      finish(reject, error);
    }
  });
}

// ============================================================================
// Execution engine
// ============================================================================
// A run walks the execution (white) edges from every start node, depth-first,
// and evaluates each node's data (purple) inputs on the way. Everything a
// node needs while running travels in one `ctx` object:
//
//   nodes, edges         the workflow as saved
//   executionEdges       edges.filter(type === 'execution'), computed once
//   nodeOutputs          id -> value, filled as nodes run (also the result)
//   workflowVariables    Set Variable / Get Variable store for this run
//   inputs               run-time values for the BeginPlay inputs
//   onNodeUpdate         status callback (processing / complete / error)

/** Pause between the nodes of a For Loop body so the UI can show each step. */
const LOOP_BODY_STEP_DELAY_MS = 300;

/** Source handles of a For Loop that leave the main flow / the loop body. */
const LOOP_BODY_HANDLE = 'loop-body';
const LOOP_COMPLETED_HANDLE = 'completed';

function notify(ctx, nodeId, status, payload) {
  if (ctx.onNodeUpdate) {
    ctx.onNodeUpdate(nodeId, status, payload);
  }
}

/**
 * Execute workflow in browser with full control and visibility
 * @param {Object} workflow - The workflow to execute
 * @param {Object} inputs - Input values for BeginPlay node
 * @param {Function} onNodeUpdate - Callback for node status updates (optional)
 * @param {Function} onInteractiveSSH - Callback for interactive SSH sessions (optional)
 * @param {Function} shouldAbort - Polled between nodes; returning true halts the run (optional)
 * @returns {Object} - { outputs, error }
 */
export async function executeWorkflowInBrowser(workflow, inputs = {}, onNodeUpdate = null, onInteractiveSSH = null, shouldAbort = null) {
  const nodes = workflow.nodes || [];
  const edges = workflow.edges || [];
  const ctx = {
    nodes,
    edges,
    executionEdges: edges.filter(e => e.type === 'execution'),
    nodeOutputs: {},
    workflowVariables: {},
    inputs,
    onNodeUpdate
  };
  // Polled between nodes so the caller (Stop button) can halt a run
  const isAborted = () => typeof shouldAbort === 'function' && shouldAbort() === true;

  try {
    const { adjacencyList, queue } = buildExecutionPlan(ctx);
    const executed = new Set(); // Track which nodes have already executed

    console.log('[Initial Queue] Starting nodes:', queue);

    // Continue depth-first: a node's downstream chain runs BEFORE any sibling
    // branch that was queued earlier (e.g. by a Sequence fan-out). With a plain
    // FIFO queue every Delay of a 4-way Sequence would run back-to-back and the
    // Visualizers behind them would all execute (and update) only at the very
    // end. Order among the given targets is preserved.
    const continueWith = (targetIds) => {
      const next = targetIds.filter((id, i) => !executed.has(id) && targetIds.indexOf(id) === i);
      if (next.length > 0) queue.unshift(...next);
    };

    // Execute nodes in topological order
    while (queue.length > 0) {
      if (isAborted()) break;

      const nodeId = queue.shift();

      // Skip if already executed (prevents duplicate execution on converging paths)
      if (executed.has(nodeId)) {
        console.log(`[Skip] ${nodeId} already executed`);
        continue;
      }

      const node = nodes.find(n => n.id === nodeId);
      if (!node) continue;

      executed.add(nodeId);
      notify(ctx, nodeId, 'processing', null);

      try {
        let result = await executeNode(node, ctx);
        if (isAborted()) break;

        console.log(`[Execute] ${node.type} (${nodeId}) returned:`, result);

        // An interactive SSH node parks the run until the terminal resolves
        if (result?.__interactiveSSH && onInteractiveSSH) {
          console.log('[Interactive SSH] Detected, showing terminal UI');
          result = await onInteractiveSSH(nodeId, result.config);
          console.log('[Interactive SSH] Session complete, result:', result);
        }

        ctx.nodeOutputs[nodeId] = result;
        notify(ctx, nodeId, 'complete', result);

        await routeAfterNode(node, result, ctx, executed, adjacencyList, continueWith);
      } catch (error) {
        console.error(`Error executing node ${nodeId}:`, error);
        notify(ctx, nodeId, 'error', error.message);
        throw error;
      }
    }

    return { outputs: ctx.nodeOutputs, error: null };
  } catch (error) {
    return { outputs: ctx.nodeOutputs, error: error.message };
  }
}

/**
 * Main-flow adjacency (execution edges minus For Loop bodies) and the start
 * queue: nodes with no incoming main-flow edge that are not a loop body
 * target, not data-only (evaluated on demand) and not annotations.
 */
function buildExecutionPlan(ctx) {
  const { nodes, executionEdges } = ctx;
  const mainFlowEdges = executionEdges.filter(e => e.sourceHandle !== LOOP_BODY_HANDLE);

  const adjacencyList = {};
  const inDegree = {};
  nodes.forEach(node => {
    adjacencyList[node.id] = [];
    inDegree[node.id] = 0;
  });
  mainFlowEdges.forEach(edge => {
    adjacencyList[edge.source].push(edge.target);
    inDegree[edge.target] = (inDegree[edge.target] || 0) + 1;
  });

  const loopBodyTargets = new Set(
    executionEdges.filter(e => e.sourceHandle === LOOP_BODY_HANDLE).map(e => e.target)
  );

  const queue = nodes
    .filter(node => inDegree[node.id] === 0)
    .filter(node => !loopBodyTargets.has(node.id))
    .filter(node => !DATA_ONLY_NODE_TYPES.includes(node.type)) // Exclude data-only nodes from initial queue
    .filter(node => !ANNOTATION_NODE_TYPES.includes(node.type)) // Notes never execute
    .map(n => n.id);

  return { adjacencyList, queue };
}

/**
 * Decide what runs after `node` finished with `result`. Control-flow nodes
 * pick their outgoing pin (and Branch/Switch replace their stored output with
 * the routed-through data); everything else follows its main-flow edges.
 */
async function routeAfterNode(node, result, ctx, executed, adjacencyList, continueWith) {
  const { executionEdges, nodeOutputs } = ctx;
  const outgoing = (sourceHandle) => executionEdges.find(e => e.source === node.id && e.sourceHandle === sourceHandle);

  if (node.type === 'branch' && result?.__branchResult !== undefined) {
    const branchEdge = outgoing(result.__branchResult ? 'true' : 'false');
    if (branchEdge) {
      continueWith([branchEdge.target]);
    }
    nodeOutputs[node.id] = result.__data;
  } else if (node.type === 'switch' && result?.__switchResult !== undefined) {
    let triggered = false;
    if (result.__switchResult >= 0) {
      const caseEdge = outgoing(`case-${result.__switchResult}`);
      if (caseEdge && !executed.has(caseEdge.target)) {
        continueWith([caseEdge.target]);
        triggered = true;
      }
    }
    if (!triggered) {
      const defaultEdge = outgoing('default');
      if (defaultEdge) {
        continueWith([defaultEdge.target]);
      }
    }
    nodeOutputs[node.id] = result.__data;
  } else if (node.type === 'forloop') {
    if (result?.__forLoopArray !== undefined) {
      const array = result.__forLoopArray;
      const loopBodyEdge = outgoing(LOOP_BODY_HANDLE);
      const completedEdge = outgoing(LOOP_COMPLETED_HANDLE);

      // The loop node's own output is the current item, so a data edge from
      // the loop into its body delivers it
      for (let i = 0; i < array.length; i++) {
        nodeOutputs[node.id] = array[i];
        if (loopBodyEdge) {
          await executeLoopBody(loopBodyEdge.target, ctx);
        }
      }

      if (completedEdge) {
        continueWith([completedEdge.target]);
      }
    }
  } else if (node.type === 'sequence') {
    const sequenceEdges = executionEdges
      .filter(e => e.source === node.id)
      .sort((a, b) => {
        const aIndex = parseInt(a.sourceHandle.split('-')[1]);
        const bIndex = parseInt(b.sourceHandle.split('-')[1]);
        return aIndex - bIndex;
      });
    // "Then 0" runs to completion (whole downstream chain) before "Then 1"
    continueWith(sequenceEdges.map(edge => edge.target));
  } else {
    continueWith(adjacencyList[node.id]);
  }
}

/**
 * Run one iteration of a For Loop body: the chain of execution edges starting
 * at `startNodeId`, excluding the loop's own loop-body / completed pins.
 * Deliberately simpler than the main loop - no interactive SSH, no control
 * flow routing, a short pause after every node so the UI can follow, and an
 * error stops this chain only (the run itself carries on).
 */
async function executeLoopBody(startNodeId, ctx) {
  const nodesToExecute = [startNodeId];
  const executed = new Set();
  const chainEdges = ctx.executionEdges.filter(e =>
    !e.sourceHandle?.includes(LOOP_BODY_HANDLE) &&
    !e.sourceHandle?.includes(LOOP_COMPLETED_HANDLE)
  );

  while (nodesToExecute.length > 0) {
    const currentNodeId = nodesToExecute.shift();
    if (executed.has(currentNodeId)) continue;
    executed.add(currentNodeId);

    const currentNode = ctx.nodes.find(n => n.id === currentNodeId);
    if (!currentNode) continue;

    try {
      notify(ctx, currentNodeId, 'processing', null);

      const result = await executeNode(currentNode, ctx);
      if (result !== null && result !== undefined) {
        ctx.nodeOutputs[currentNodeId] = result;
      }

      notify(ctx, currentNodeId, 'complete', result);

      // Depth-first, same as the main loop: finish this chain before siblings
      const outgoingEdges = chainEdges.filter(e => e.source === currentNodeId);
      nodesToExecute.unshift(...outgoingEdges.map(edge => edge.target));

      await new Promise(resolve => setTimeout(resolve, LOOP_BODY_STEP_DELAY_MS));
    } catch (error) {
      console.error(`Error executing node ${currentNodeId} in chain:`, error);
      notify(ctx, currentNodeId, 'error', error.message);
      break;
    }
  }
}

/**
 * Gather what arrives on `node`'s data pins: the stored output of every
 * source (pin-less variable nodes are evaluated on demand here), a BeginPlay
 * `output-<field>` handle narrowed to that field. null/undefined values are
 * dropped; a single remaining value is unwrapped, several stay an array, and
 * a node with no data edges gets null.
 */
async function resolveInputData(node, ctx) {
  const { edges, nodes, nodeOutputs } = ctx;
  const dataEdges = edges.filter(e => e.target === node.id && e.type === 'data');
  if (dataEdges.length === 0) return null;

  const inputValues = await Promise.all(dataEdges.map(async e => {
    let sourceData = nodeOutputs[e.source];
    const sourceNode = nodes.find(n => n.id === e.source);

    console.log(`[Data Edge] ${sourceNode?.type} (${e.source}) -> ${node.type} (${node.id})`, sourceData);

    // Execute data-only nodes on-demand (nodes with no exec pins)
    if (sourceData === undefined && sourceNode && DATA_ONLY_NODE_TYPES.includes(sourceNode.type)) {
      sourceData = await executeNode(sourceNode, ctx);
      nodeOutputs[e.source] = sourceData;
      console.log(`[On-Demand] ${sourceNode.type} returned:`, sourceData);
    }

    // Handle BeginPlay output handles
    if (sourceNode?.type === 'beginplay' && e.sourceHandle?.startsWith('output-')) {
      const fieldName = e.sourceHandle.substring(7);
      return sourceData?.[fieldName];
    }

    return sourceData;
  }));

  const filteredInputs = inputValues.filter(v => v !== undefined && v !== null);
  const inputData = filteredInputs.length === 1 ? filteredInputs[0] : filteredInputs;
  console.log(`[${node.type}] Input data:`, inputData);
  return inputData;
}

/** Resolve a node's inputs, then run the node-type-specific logic. */
async function executeNode(node, ctx) {
  const inputData = await resolveInputData(node, ctx);
  return executeNodeByType(node, inputData, ctx);
}

/** Second half of executeNode: one case per node type. */
async function executeNodeByType(node, inputData, ctx) {
  const { edges, nodeOutputs, workflowVariables, inputs } = ctx;

  switch (node.type) {
    case 'beginplay': {
      // Each declared input takes the run-time value when one was given,
      // otherwise whatever is wired into its input-<name> pin (already
      // evaluated by resolveInputData), otherwise null.
      const result = {};
      const beginPlayInputs = node.data.inputs || {};

      for (const inputName of Object.keys(beginPlayInputs)) {
        if (inputs && inputs[inputName] !== undefined && inputs[inputName] !== null && inputs[inputName] !== '') {
          result[inputName] = inputs[inputName];
        } else {
          const inputEdge = edges.find(e => e.target === node.id && e.targetHandle === `input-${inputName}`);
          result[inputName] = inputEdge ? nodeOutputs[inputEdge.source] : null;
        }
      }
      return result;
    }

    case 'string':
    case 'text':
      return await replaceEnvironmentVariables(node.data.value || '');

    case 'integer': {
      const intValue = node.data.value;
      return typeof intValue === 'number' ? intValue : (parseInt(intValue) || 0);
    }

    case 'boolean':
      // If input is connected, use that value; otherwise use configured value
      if (inputData !== null && inputData !== undefined) {
        return Boolean(inputData);
      }
      return node.data.value || false;

    case 'object': {
      const objValue = node.data.value || '{}';
      try {
        return JSON.parse(objValue);
      } catch {
        throw new Error('Invalid JSON in Object variable');
      }
    }

    case 'array': {
      const arrValue = node.data.value || '[]';
      try {
        const parsed = JSON.parse(arrValue);
        if (Array.isArray(parsed)) {
          return parsed;
        } else {
          throw new Error('Value is not an array');
        }
      } catch (err) {
        throw new Error(`Invalid JSON in Array variable: ${err.message}`);
      }
    }

    case 'makearray': {
      const delimiter = node.data.delimiter || ',';

      if (Array.isArray(inputData)) {
        return inputData;
      } else if (inputData !== null && inputData !== undefined) {
        // Convert to string and split by delimiter
        return String(inputData).split(delimiter).map(item => item.trim());
      }
      return [];
    }

    case 'restapi':
      return executeRestApi(node, inputData);

    case 'ssh':
      return executeSsh(node, inputData);

    case 'transformation': {
      const { code } = node.data;
      if (!code) return inputData;

      try {
        // Never `new Function(code)` here: this file runs in the privileged
        // renderer where window.electronAPI is in scope, and the workflow may
        // have been synced from another machine. See runTransformation.
        return await runTransformation(code, inputData);
      } catch (error) {
        throw new Error(`Transformation error: ${error.message}`);
      }
    }

    case 'delay': {
      const { duration = 1000 } = node.data;
      let actualDuration = duration;

      if (typeof inputData === 'number' && inputData > 0) {
        actualDuration = inputData;
      } else if (inputData && typeof inputData === 'object' && typeof inputData.duration === 'number') {
        actualDuration = inputData.duration;
      }

      await new Promise(resolve => setTimeout(resolve, actualDuration));
      return inputData;
    }

    case 'branch': {
      let condition = false;
      if (typeof inputData === 'boolean') {
        condition = inputData;
      } else if (inputData && typeof inputData === 'object' && typeof inputData.condition === 'boolean') {
        condition = inputData.condition;
      }
      return { __branchResult: condition, __data: inputData };
    }

    case 'switch': {
      const { cases = [] } = node.data;

      for (let i = 0; i < cases.length; i++) {
        if (String(inputData) === String(cases[i].value)) {
          return { __switchResult: i, __data: inputData };
        }
      }
      return { __switchResult: -1, __data: inputData };
    }

    case 'sequence':
      return inputData;

    case 'forloop': {
      const { iterations = 3 } = node.data;
      let array = [];

      if (Array.isArray(inputData)) {
        array = inputData;
      } else if (typeof iterations === 'number') {
        array = Array.from({ length: iterations }, (_, i) => i);
      }

      return { __forLoopArray: array };
    }

    case 'storage': {
      const varName = node.data.variableName || 'data';
      workflowVariables[varName] = inputData;
      return { stored: true, variableName: varName, value: inputData };
    }

    case 'variablereference': {
      const varName = node.data.variableName || 'data';
      return workflowVariables[varName];
    }

    case 'comparison': {
      const operator = node.data.operator || '>';

      // Left and right come from their own pins (both already evaluated by
      // resolveInputData, so their outputs are stored)
      let leftValue = null;
      let rightValue = null;
      for (const edge of edges.filter(e => e.target === node.id && e.type === 'data')) {
        if (edge.targetHandle === 'left-in') {
          leftValue = nodeOutputs[edge.source];
        } else if (edge.targetHandle === 'right-in') {
          rightValue = nodeOutputs[edge.source];
        }
      }

      switch (operator) {
        case '>': return leftValue > rightValue;
        case '<': return leftValue < rightValue;
        case '==': return leftValue == rightValue;
        case '!=': return leftValue != rightValue;
        case '>=': return leftValue >= rightValue;
        case '<=': return leftValue <= rightValue;
        default: return false;
      }
    }

    case 'visualizer':
    case 'result':
      console.log(`[${node.type}] Input data:`, inputData);
      return inputData;

    default:
      return null;
  }
}

/** REST API node: proxied through Electron or the backend where available. */
async function executeRestApi(node, inputData) {
  let { url, method = 'GET', headers = '{}', body = '' } = node.data;

  if (inputData && typeof inputData === 'object') {
    if (inputData.url) url = inputData.url;
    if (inputData.method) method = inputData.method;
    if (inputData.headers) headers = typeof inputData.headers === 'string' ? inputData.headers : JSON.stringify(inputData.headers);
    if (inputData.body) body = typeof inputData.body === 'string' ? inputData.body : JSON.stringify(inputData.body);
  }

  if (!url) {
    throw new Error('URL is required');
  }

  const processedUrl = await replaceEnvironmentVariables(url);
  const options = {
    method,
    headers: JSON.parse(headers || '{}'),
  };

  if (method !== 'GET' && body) {
    options.body = body;
  }

  // Inside Electron, proxy the request through the main process
  // ('workflow-http-request' IPC handler in electron/main.cjs): the
  // main process is not subject to renderer CORS/webSecurity, so the
  // node can reach arbitrary user-configured URLs.
  if (window.electronAPI?.workflowHttpRequest) {
    const result = await window.electronAPI.workflowHttpRequest(processedUrl, options);
    if (!result.ok) {
      throw new Error(`HTTP ${result.status}: ${result.statusText}`);
    }
    return result.body;
  }
  // In a browser served by the container the backend proxies the
  // request the same way (POST /api/workflow/http-request, behind the
  // SSRF guard in backend/safe_url.py).
  if (can('httpProxy')) {
    const response = await apiFetch(`${await getBackendUrl()}/api/workflow/http-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: processedUrl,
        method: options.method,
        headers: options.headers,
        body: options.body,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || `HTTP ${response.status}: ${response.statusText}`);
    }
    if (!result.ok) {
      throw new Error(`HTTP ${result.status}: ${result.statusText}`);
    }
    return result.body;
  }

  // Not running inside Electron (no IPC bridge available) - fall back
  // to a direct fetch, same as before, still subject to the browser's
  // own CORS.
  const response = await fetch(processedUrl, options);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return await response.json();
  }

  return await response.text();
}

/**
 * SSH node: returns the `__interactiveSSH` marker (the engine then parks on
 * onInteractiveSSH) or runs the command through the backend.
 */
async function executeSsh(node, inputData) {
  let { host, port = '22', username, authMethod = 'agent', password, command, sshOptions = '', interactive = false } = node.data;

  // Allow input data to override SSH config
  if (inputData && typeof inputData === 'object') {
    if (inputData.host) host = inputData.host;
    if (inputData.port) port = inputData.port;
    if (inputData.username) username = inputData.username;
    if (inputData.authMethod) authMethod = inputData.authMethod;
    if (inputData.password) password = inputData.password;
    if (inputData.command) command = inputData.command;
    if (inputData.sshOptions) sshOptions = inputData.sshOptions;
    if (inputData.interactive !== undefined) interactive = inputData.interactive;
  }

  if (!host || !username || !command) {
    throw new Error('SSH requires host, username, and command');
  }

  const config = {
    host: await replaceEnvironmentVariables(host),
    port: parseInt(port) || 22,
    username: await replaceEnvironmentVariables(username),
    authMethod,
    password: password ? await replaceEnvironmentVariables(password) : '',
    command: await replaceEnvironmentVariables(command),
    sshOptions: sshOptions ? await replaceEnvironmentVariables(sshOptions) : ''
  };

  if (interactive) {
    return { __interactiveSSH: true, config };
  }

  const backendUrl = await getBackendUrl();
  const response = await apiFetch(`${backendUrl}/api/execute-ssh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`SSH error: ${errorData.error || response.statusText}`);
  }

  const result = await response.json();
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.exitCode || 0,
    success: result.exitCode === 0
  };
}
