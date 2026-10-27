const express = require('express');
const cors = require('cors');
const { networkInterfaces } = require('os');
const crypto = require('crypto');
const net = require('net');
const { safeRequest, workflowPrivateUrlsAllowed } = require('./safe-url.cjs');

const app = express();
const PORT = process.env.PORT || 8080;

// ---------------------------------------------------------------------------
// Security boundary - identical to the Flask backend (backend/extensions.py)
//
// This Node server is the development backend and the fallback when the
// packaged Flask binary is missing (see startBackendServer in main.cjs). It
// used to listen on 0.0.0.0 with wildcard CORS and no authentication, so any
// host on the network - or any web page open in any local browser - could
// run workflows (with their SSH nodes), fetch arbitrary URLs through it and
// fill its queues. It now applies the same three controls as Flask:
//   1. CORS restricted to the app's own origins (Vite dev server, and the
//      literal "null" Chromium reports for the packaged file:// renderer);
//   2. every request except /health must carry the per-launch X-App-Token
//      that main.cjs generates and passes via APP_AUTH_TOKEN
//      (constant-time compare, fail closed if the token is missing);
//   3. bind to 127.0.0.1 only.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'null'];
const APP_AUTH_TOKEN = process.env.APP_AUTH_TOKEN || '';
if (!APP_AUTH_TOKEN) {
  console.error('[SECURITY WARNING] APP_AUTH_TOKEN is not set. This backend is expected to be '
    + 'launched by the Electron app, which generates and passes this token. Every request '
    + 'except /health will be rejected.');
}

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: '50mb' }));
// Express 5 leaves req.body undefined when nothing was parsed (4 set {}); the
// routes destructure it, so keep the old shape
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

function tokenMatches(supplied) {
  if (!APP_AUTH_TOKEN || typeof supplied !== 'string' || !supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(APP_AUTH_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.use((req, res, next) => {
  if (req.method === 'OPTIONS' || req.path === '/health') return next();
  if (!APP_AUTH_TOKEN) {
    return res.status(500).json({ error: 'Server misconfigured: APP_AUTH_TOKEN not set' });
  }
  if (!tokenMatches(req.get('X-App-Token'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
});

// Bound for the in-memory P2P queues below: oldest entries are dropped once
// a queue exceeds this many items, so a peer cannot grow memory unbounded.
const MAX_PENDING_PER_QUEUE = 500;
function pushBounded(queue, item) {
  queue.push(item);
  if (queue.length > MAX_PENDING_PER_QUEUE) {
    queue.splice(0, queue.length - MAX_PENDING_PER_QUEUE);
  }
}

// Legacy direct-P2P broadcast targets are "host[:port]" strings supplied by
// the caller. Only a bare hostname/IP literal with an optional numeric port
// is accepted - no scheme, path, userinfo or whitespace - and the resulting
// URL still goes through safeRequest() like every other outbound request.
function validatePeerAddress(peer) {
  const value = String(peer || '').trim();
  const match = value.match(/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/);
  if (!match) {
    throw new Error(`Invalid peer address: ${JSON.stringify(peer)}`);
  }
  if (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535)) {
    throw new Error(`Invalid peer port: ${match[2]}`);
  }
  const host = match[1];
  if (host.startsWith('[') && !net.isIPv6(host.slice(1, -1))) {
    throw new Error(`Invalid peer address: ${JSON.stringify(peer)}`);
  }
  return value;
}

// ============================================================================
// P2P CLOUD SYNC - PENDING QUEUES
// ============================================================================

// In-memory queues for received documents and workflows from peers
// Key: backend machine_id, Value: array of pending items
// All items go to same queue on a single backend, polling machines filter by ownerId
const pendingDocuments = {};
const pendingWorkflows = {};

// ============================================================================
// MACHINE ID GENERATION
// ============================================================================

function getMachineId() {
  try {
    const interfaces = networkInterfaces();
    const macs = [];

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.mac && iface.mac !== '00:00:00:00:00:00') {
          macs.push(iface.mac);
        }
      }
    }

    if (macs.length > 0) {
      // Sort for consistency
      macs.sort();
      // Hash the first MAC address for privacy
      return crypto.createHash('sha256').update(macs[0]).digest('hex').substring(0, 16);
    }
  } catch (error) {
    console.error('Error getting machine ID:', error);
  }

  return 'unknown-machine';
}

// ============================================================================
// WORKFLOW EXECUTION ENGINE
// ============================================================================

function buildExecutionGraph(nodes, edges) {
  const execGraph = {};
  const dataGraph = {};

  for (const node of nodes) {
    execGraph[node.id] = [];
    dataGraph[node.id] = [];
  }

  for (const edge of edges) {
    const { source, target, sourceHandle = '', targetHandle = '', type = '' } = edge;

    // Execution edges: explicit type='execution' OR both handles contain 'exec' OR special control flow handles
    const isExecutionEdge = (
      type === 'execution' ||
      (sourceHandle.includes('exec') && targetHandle.includes('exec')) ||
      ['loop-body', 'completed', 'true', 'false'].includes(sourceHandle) ||
      targetHandle.startsWith('exec-')
    );

    if (isExecutionEdge) {
      execGraph[source].push({ target, sourceHandle, targetHandle });
    } else {
      dataGraph[source].push({ target, sourceHandle, targetHandle });
    }
  }

  return { execGraph, dataGraph };
}

function getNodeOutputValue(nodeId, sourceHandle, nodeOutputs, nodesById) {
  const output = nodeOutputs[nodeId];
  if (!output) return null;

  if (sourceHandle.startsWith('output-')) {
    const key = sourceHandle.replace('output-', '');
    return output[key] !== undefined ? output[key] : output;
  }

  return output;
}

function findDataDependencies(nodeId, edges) {
  const dependencies = [];

  for (const edge of edges) {
    if (edge.target === nodeId) {
      const targetHandle = edge.targetHandle || '';
      const edgeType = edge.type || '';
      const isDataEdge = edgeType === 'data' || (!targetHandle.includes('exec') && targetHandle !== '');

      if (isDataEdge) {
        dependencies.push(edge);
      }
    }
  }

  return dependencies;
}

async function executeNode(node, inputsData, nodeOutputs, edges, nodesById, envVars = {}, workflowVariables = {}) {
  const nodeType = node.type;
  const nodeData = node.data || {};

  console.log(`Executing node: ${node.id} (${nodeType})`);

  switch (nodeType) {
    case 'beginplay': {
      const outputs = {};
      const dependencies = findDataDependencies(node.id, edges);

      for (const dep of dependencies) {
        const sourceNode = nodesById[dep.source];
        if (!sourceNode) continue;

        const sourceHandle = dep.sourceHandle || '';
        const targetHandle = dep.targetHandle || '';

        if (targetHandle.startsWith('input-')) {
          const inputName = targetHandle.replace('input-', '');
          let value = null;

          if (sourceNode.type === 'string' || sourceNode.type === 'text') {
            value = sourceNode.data.value || '';
          } else if (sourceNode.type === 'integer') {
            value = parseInt(sourceNode.data.value || '0', 10);
          } else if (sourceNode.type === 'variablereference') {
            const varName = sourceNode.data.variableName || 'data';
            value = workflowVariables[varName];
          } else {
            value = getNodeOutputValue(dep.source, sourceHandle, nodeOutputs, nodesById);
          }

          outputs[inputName] = value;
        }
      }

      // Merge with inputsData, with user-provided inputs taking precedence
      if (inputsData) {
        return { ...outputs, ...inputsData };
      }

      return outputs;
    }

    case 'string':
    case 'text': {
      let value = nodeData.value || '';
      // Replace environment variables
      value = value.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
        const trimmed = varName.trim();
        return trimmed in envVars ? envVars[trimmed] : match;
      });
      return value;
    }

    case 'integer': {
      return parseInt(nodeData.value || '0', 10);
    }

    case 'variablereference': {
      const varName = nodeData.variableName || 'data';
      return workflowVariables[varName];
    }

    case 'storage': {
      const dependencies = findDataDependencies(node.id, edges);
      let valueToStore = null;

      for (const dep of dependencies) {
        valueToStore = getNodeOutputValue(dep.source, dep.sourceHandle || '', nodeOutputs, nodesById);
        if (valueToStore !== null) break;
      }

      const varName = nodeData.variableName || 'data';
      workflowVariables[varName] = valueToStore;

      return { stored: true, variableName: varName, value: valueToStore };
    }

    case 'http':
    case 'restapi': {
      // Outbound requests go through safeRequest() (electron/safe-url.cjs).
      const method = nodeData.method || 'GET';
      let url = nodeData.url || '';

      // Replace env vars in URL
      url = url.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
        const trimmed = varName.trim();
        return trimmed in envVars ? envVars[trimmed] : match;
      });

      const dependencies = findDataDependencies(node.id, edges);
      let bodyData = null;

      for (const dep of dependencies) {
        if (dep.targetHandle === 'body-in') {
          bodyData = getNodeOutputValue(dep.source, dep.sourceHandle || '', nodeOutputs, nodesById);
          break;
        }
      }

      const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
      };

      if (bodyData && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        options.body = typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData);
      }

      // Guarded fetch: validates the URL and every redirect hop against
      // loopback/private/link-local ranges, pins the connection to the
      // validated address and caps the body (see electron/safe-url.cjs).
      const response = await safeRequest(url, options, {
        allowPrivate: workflowPrivateUrlsAllowed()
      });
      const text = response.text;

      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }

    case 'result':
    case 'visualizer': {
      const dependencies = findDataDependencies(node.id, edges);
      let outputValue = null;

      for (const dep of dependencies) {
        outputValue = getNodeOutputValue(dep.source, dep.sourceHandle || '', nodeOutputs, nodesById);
        if (outputValue !== null) break;
      }

      return outputValue;
    }

    case 'delay': {
      const dependencies = findDataDependencies(node.id, edges);
      let delayMs = parseInt(nodeData.delay || '1000', 10);
      let inputValue = null;

      // Check for delay from data connection
      for (const dep of dependencies) {
        if (dep.targetHandle === 'delay-in') {
          const val = getNodeOutputValue(dep.source, dep.sourceHandle || '', nodeOutputs, nodesById);
          if (val !== null && val !== undefined) {
            delayMs = parseInt(val, 10);
          }
        } else if (dep.targetHandle === 'in') {
          inputValue = getNodeOutputValue(dep.source, dep.sourceHandle || '', nodeOutputs, nodesById);
        }
      }

      console.log(`Delaying for ${delayMs}ms`);
      await new Promise(resolve => setTimeout(resolve, delayMs));

      return inputValue;
    }

    case 'forloop': {
      const dependencies = findDataDependencies(node.id, edges);
      let arrayData = [];
      let iterations = parseInt(nodeData.iterations || '3', 10);

      // Check for array data or iteration count from connections
      for (const dep of dependencies) {
        if (dep.targetHandle === 'array-in') {
          const arr = getNodeOutputValue(dep.source, dep.sourceHandle || '', nodeOutputs, nodesById);
          if (Array.isArray(arr)) {
            arrayData = arr;
          }
        } else if (dep.targetHandle === 'iterations-in') {
          const val = getNodeOutputValue(dep.source, dep.sourceHandle || '', nodeOutputs, nodesById);
          if (val !== null && val !== undefined) {
            iterations = parseInt(val, 10);
          }
        }
      }

      // Use array length if array provided, otherwise use iterations count
      if (arrayData.length === 0) {
        arrayData = Array.from({ length: iterations }, (_, i) => i);
      }

      return { items: arrayData, count: arrayData.length };
    }

    case 'transformation':
    case 'transform': {
      const dependencies = findDataDependencies(node.id, edges);
      let inputValue = null;

      for (const dep of dependencies) {
        inputValue = getNodeOutputValue(dep.source, dep.sourceHandle || '', nodeOutputs, nodesById);
        if (inputValue !== null) break;
      }

      const transformType = nodeData.transform || 'uppercase';

      if (inputValue === null || inputValue === undefined) {
        return inputValue;
      }

      const strValue = String(inputValue);

      switch (transformType) {
        case 'uppercase':
          return strValue.toUpperCase();
        case 'lowercase':
          return strValue.toLowerCase();
        case 'trim':
          return strValue.trim();
        case 'reverse':
          return strValue.split('').reverse().join('');
        default:
          return strValue;
      }
    }

    case 'makearray': {
      const dependencies = findDataDependencies(node.id, edges);
      const items = [];

      // Collect all items from data inputs
      for (const dep of dependencies) {
        const value = getNodeOutputValue(dep.source, dep.sourceHandle || '', nodeOutputs, nodesById);
        if (value !== null && value !== undefined) {
          items.push(value);
        }
      }

      return items;
    }

    case 'branch': {
      const dependencies = findDataDependencies(node.id, edges);
      let condition = false;

      for (const dep of dependencies) {
        if (dep.targetHandle === 'condition-in') {
          const val = getNodeOutputValue(dep.source, dep.sourceHandle || '', nodeOutputs, nodesById);
          condition = Boolean(val);
          break;
        }
      }

      return { condition, result: condition };
    }

    case 'switch': {
      const dependencies = findDataDependencies(node.id, edges);
      let inputValue = null;

      for (const dep of dependencies) {
        if (dep.targetHandle === 'value-in') {
          inputValue = getNodeOutputValue(dep.source, dep.sourceHandle || '', nodeOutputs, nodesById);
          break;
        }
      }

      const cases = nodeData.cases || [];
      const defaultCase = nodeData.default || null;

      for (const caseItem of cases) {
        if (String(inputValue) === String(caseItem.value)) {
          return { matched: caseItem.value, case: caseItem.value };
        }
      }

      return { matched: defaultCase, case: 'default' };
    }

    case 'sequence': {
      // Sequence node - execute multiple branches
      // For sequence, we don't produce data output, just control flow
      return null;
    }

    default:
      return null;
  }
}

function topologicalSort(nodes, execGraph) {
  const visited = new Set();
  const result = [];

  function visit(nodeId) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const neighbors = execGraph[nodeId] || [];
    for (const edge of neighbors) {
      visit(edge.target);
    }

    result.unshift(nodeId);
  }

  for (const node of nodes) {
    visit(node.id);
  }

  return result;
}

async function executeNodeChain(startNodeId, execGraph, edges, nodesById, nodeOutputs, envVars, workflowVariables, inputs, loopItemData = null) {
  const nodesToExecute = [startNodeId];
  const executed = new Set();

  while (nodesToExecute.length > 0) {
    const currentNodeId = nodesToExecute.shift();

    if (executed.has(currentNodeId)) continue;
    executed.add(currentNodeId);

    const currentNode = nodesById[currentNodeId];
    if (!currentNode) continue;

    // Use loop item data for the current iteration if available
    const nodeInput = loopItemData !== null ? loopItemData : inputs;
    const output = await executeNode(currentNode, nodeInput, nodeOutputs, edges, nodesById, envVars, workflowVariables);
    nodeOutputs[currentNodeId] = output;

    // Find next nodes in execution chain
    const nextNodes = execGraph[currentNodeId] || [];
    for (const edge of nextNodes) {
      nodesToExecute.push(edge.target);
    }
  }
}

async function executeWorkflow(workflow, inputs = {}, envVars = {}) {
  const nodes = workflow.nodes || [];
  const edges = workflow.edges || [];

  const nodesById = {};
  for (const node of nodes) {
    nodesById[node.id] = node;
  }

  const { execGraph, dataGraph } = buildExecutionGraph(nodes, edges);
  const executionOrder = topologicalSort(nodes, execGraph);

  const nodeOutputs = {};
  const workflowVariables = {};

  for (const nodeId of executionOrder) {
    const node = nodesById[nodeId];
    if (!node) continue;

    try {
      // Special handling for forloop nodes
      if (node.type === 'forloop') {
        const output = await executeNode(node, inputs, nodeOutputs, edges, nodesById, envVars, workflowVariables);
        nodeOutputs[nodeId] = output;

        // Find the loop body edge (from loop-body handle)
        const loopBodyEdge = edges.find(e => e.source === nodeId && e.sourceHandle === 'loop-body');

        if (loopBodyEdge && output && output.items) {
          console.log(`Executing forloop ${nodeId} for ${output.items.length} iterations`);

          // Execute the loop body for each item
          for (let i = 0; i < output.items.length; i++) {
            const item = output.items[i];
            console.log(`  Loop iteration ${i + 1}/${output.items.length}: ${item}`);

            // Execute the chain starting from the loop body node with the current item
            await executeNodeChain(
              loopBodyEdge.target,
              execGraph,
              edges,
              nodesById,
              nodeOutputs,
              envVars,
              workflowVariables,
              inputs,
              item
            );
          }
        }
      } else {
        const output = await executeNode(node, inputs, nodeOutputs, edges, nodesById, envVars, workflowVariables);
        nodeOutputs[nodeId] = output;
      }
    } catch (error) {
      console.error(`Error executing node ${nodeId}:`, error);
      throw error;
    }
  }

  return nodeOutputs;
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

// Workflow execution
app.post('/api/workflow/execute', async (req, res) => {
  try {
    const { workflow, inputs, env_vars } = req.body;

    if (!workflow || !workflow.nodes) {
      return res.status(400).json({ error: 'Invalid workflow data' });
    }

    const result = await executeWorkflow(workflow, inputs || {}, env_vars || {});

    res.json({
      success: true,
      outputs: result
    });
  } catch (error) {
    console.error('Workflow execution error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Machine ID
app.get('/api/cloud/machine_id', (req, res) => {
  res.json({ machine_id: getMachineId() });
});

// P2P Broadcast (documents)
app.post('/api/cloud/broadcast', async (req, res) => {
  try {
    const { document, peer_ips } = req.body;
    console.log('[Broadcast] Starting document broadcast');
    console.log('[Broadcast] Document ID:', document?.id);
    console.log('[Broadcast] Document title:', document?.title);
    console.log('[Broadcast] Peer IPs:', peer_ips);

    // Outbound requests go through safeRequest() (electron/safe-url.cjs).

    const broadcast_results = [];
    for (const ip of peer_ips) {
      try {
        const url = `http://${validatePeerAddress(ip)}/api/cloud/receive`;
        console.log(`[Broadcast] Attempting to send to: ${url}`);

        // Peers are LAN hosts: same private-network policy as workflow nodes
        // (on by default); loopback/link-local stay rejected regardless.
        const response = await safeRequest(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ document })
        }, { allowPrivate: workflowPrivateUrlsAllowed(), timeoutMs: 5000 });

        console.log(`[Broadcast] Response from ${ip}: status=${response.status}, ok=${response.ok}`);
        broadcast_results.push({ peer: ip, success: response.ok, status: response.status });
      } catch (error) {
        console.error(`[Broadcast] Error sending to ${ip}:`, error.message);
        broadcast_results.push({ peer: ip, success: false, error: error.message });
      }
    }

    console.log('[Broadcast] Final results:', broadcast_results);
    res.json({ success: true, broadcast_results });
  } catch (error) {
    console.error('[Broadcast] Fatal error:', error);
    res.status(500).json({ error: error.message });
  }
});

// P2P Receive (documents)
app.post('/api/cloud/receive', (req, res) => {
  const { document, sender_id } = req.body;
  console.log('[Receive] Received document from peer');
  console.log('[Receive] Sender ID:', sender_id);
  console.log('[Receive] Document ID:', document?.id);
  console.log('[Receive] Document title:', document?.title);
  console.log('[Receive] Document in cloud:', document?.inCloud);
  console.log('[Receive] Document ownerId:', document?.ownerId);

  // Add document to pending queue for frontend to process
  if (document) {
    const backendMachineId = getMachineId();
    if (!pendingDocuments[backendMachineId]) {
      pendingDocuments[backendMachineId] = [];
    }
    pushBounded(pendingDocuments[backendMachineId], document);
    console.log(`[Receive] Added document to pending queue (${pendingDocuments[backendMachineId].length} pending)`);
  }

  res.json({ success: true });
});

// P2P Broadcast Workflow
app.post('/api/cloud/broadcast_workflow', async (req, res) => {
  try {
    const { workflow, peer_ips } = req.body;
    console.log('[Broadcast Workflow] Starting workflow broadcast');
    console.log('[Broadcast Workflow] Workflow ID:', workflow?.id);
    console.log('[Broadcast Workflow] Workflow title:', workflow?.title);
    console.log('[Broadcast Workflow] Peer IPs:', peer_ips);

    // Outbound requests go through safeRequest() (electron/safe-url.cjs).

    const broadcast_results = [];
    for (const ip of peer_ips) {
      try {
        const url = `http://${validatePeerAddress(ip)}/api/cloud/receive_workflow`;
        console.log(`[Broadcast Workflow] Attempting to send to: ${url}`);

        // Same LAN-peer policy as the document broadcast above.
        const response = await safeRequest(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workflow })
        }, { allowPrivate: workflowPrivateUrlsAllowed(), timeoutMs: 5000 });

        console.log(`[Broadcast Workflow] Response from ${ip}: status=${response.status}, ok=${response.ok}`);
        broadcast_results.push({ peer: ip, success: response.ok, status: response.status });
      } catch (error) {
        console.error(`[Broadcast Workflow] Error sending to ${ip}:`, error.message);
        broadcast_results.push({ peer: ip, success: false, error: error.message });
      }
    }

    console.log('[Broadcast Workflow] Final results:', broadcast_results);
    res.json({ success: true, broadcast_results });
  } catch (error) {
    console.error('[Broadcast Workflow] Fatal error:', error);
    res.status(500).json({ error: error.message });
  }
});

// P2P Receive Workflow
app.post('/api/cloud/receive_workflow', (req, res) => {
  const { workflow, sender_id } = req.body;
  console.log('[Receive Workflow] Received workflow from peer');
  console.log('[Receive Workflow] Sender ID:', sender_id);
  console.log('[Receive Workflow] Workflow ID:', workflow?.id);
  console.log('[Receive Workflow] Workflow title:', workflow?.title);
  console.log('[Receive Workflow] Workflow in cloud:', workflow?.inCloud);
  console.log('[Receive Workflow] Workflow ownerId:', workflow?.ownerId);

  // Add workflow to pending queue for frontend to process
  if (workflow) {
    const backendMachineId = getMachineId();
    if (!pendingWorkflows[backendMachineId]) {
      pendingWorkflows[backendMachineId] = [];
    }
    pushBounded(pendingWorkflows[backendMachineId], workflow);
    console.log(`[Receive Workflow] Added workflow to pending queue (${pendingWorkflows[backendMachineId].length} pending)`);
  }

  res.json({ success: true });
});

// P2P Pending queue
app.get('/api/cloud/pending', (req, res) => {
  // Get machine_id from query parameter (sent by frontend)
  // This allows testing with localStorage override on same backend
  let machineId = req.query.machine_id;

  if (!machineId) {
    // Fallback to backend machine ID if not provided
    machineId = getMachineId();
  }

  // Use the backend's machine_id for the queue key (all docs go to same queue on same backend)
  const backendMachineId = getMachineId();

  // Initialize queues if they don't exist
  if (!pendingDocuments[backendMachineId]) {
    pendingDocuments[backendMachineId] = [];
  }
  if (!pendingWorkflows[backendMachineId]) {
    pendingWorkflows[backendMachineId] = [];
  }

  // Filter out documents where ownerId matches the requesting machine
  // This prevents a machine from receiving its own documents
  const allPendingDocs = pendingDocuments[backendMachineId];
  const filteredPendingDocs = allPendingDocs.filter(doc => doc.ownerId !== machineId);

  // Remove only the documents being delivered to this machine
  // Keep documents that belong to other machines (for multi-machine testing)
  pendingDocuments[backendMachineId] = allPendingDocs.filter(doc => doc.ownerId === machineId);

  // Same for workflows
  const allPendingWorkflows = pendingWorkflows[backendMachineId];
  const filteredPendingWorkflows = allPendingWorkflows.filter(wf => wf.ownerId !== machineId);
  pendingWorkflows[backendMachineId] = allPendingWorkflows.filter(wf => wf.ownerId === machineId);

  if (filteredPendingDocs.length > 0 || filteredPendingWorkflows.length > 0) {
    console.log(`[Pending] Sending ${filteredPendingDocs.length} document(s) and ${filteredPendingWorkflows.length} workflow(s) to machine ${machineId}`);
  }

  res.json({
    success: true,
    pending_documents: filteredPendingDocs,
    pending_workflows: filteredPendingWorkflows
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'jacarium-backend' });
});

// Errors reach here: a body the JSON parser refuses (400, or 413 over the
// limit), and - new with Express 5 - a throw or a rejected promise in a
// handler. Always JSON, with the error's own status; never Express's default
// HTML page, which carries the stack trace. (Four parameters: that is how
// Express tells an error handler from middleware.)
app.use((err, req, res, next) => {
  const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error('[Server] Unhandled error:', (err && err.stack) || err);
  const message = status >= 500 ? 'Internal server error'
    : err.type === 'entity.parse.failed' ? 'Malformed JSON body'
      : err.type === 'entity.too.large' ? 'Request body too large'
        : (err.expose && err.message) || 'Bad request';
  res.status(status).json({ error: message });
});

// Start server
// Loopback only: this backend serves the local Electron renderer and nothing
// else (the Flask backend binds the same way).
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Backend server running on http://127.0.0.1:${PORT}`);
});
