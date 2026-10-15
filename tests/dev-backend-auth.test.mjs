/**
 * Guards the hardening of the Node dev/fallback backend (electron/server.cjs).
 *
 * THE BUG: that server - used in development and as the fallback whenever
 * the packaged Flask binary is missing - listened on 0.0.0.0 with wildcard
 * CORS and NO authentication, while exposing workflow execution (SSH nodes
 * included), arbitrary URL fetches and unbounded in-memory queues. Any host
 * on the network, or any web page in any local browser, could drive it.
 *
 * THE FIX mirrors backend/extensions.py exactly: every request except
 * /health must carry the per-launch X-App-Token (constant-time compare,
 * fail closed when unset), CORS is restricted to the app's own origins,
 * the listener binds 127.0.0.1 only, queues are capped, peer addresses are
 * validated and outbound requests go through the shared SSRF guard.
 *
 * What this test proves against a REAL spawned server.cjs:
 *   - /health is open; every API route is 401 without / with a wrong token
 *     and 200 with the right one; CORS preflight passes without a token;
 *   - foreign Origin gets no Access-Control-Allow-Origin, "null" and the
 *     Vite dev origin are reflected;
 *   - the port is bound on 127.0.0.1 only (connecting via a non-loopback
 *     interface, when one exists, is refused);
 *   - the pending queue never exceeds its cap;
 *   - a malformed peer address is rejected without any request;
 *   - the workflow REST node refuses an internal URL;
 *   - started WITHOUT a token, every non-health request is 500 (fail closed).
 *
 * Run:  node tests/dev-backend-auth.test.mjs
 * Preconditions: repo deps installed (npm install - express/cors).
 * Exit code 0 = all checks passed, 1 = failure (details on stdout).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

async function spawnBackend(token) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  delete env.APP_AUTH_TOKEN;
  if (token) env.APP_AUTH_TOKEN = token;
  const proc = spawn('node', [path.join(REPO, 'electron', 'server.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch { /* not yet */ }
    if (!up) await sleep(100);
  }
  if (!up) { console.error('backend did not start:\n' + log); proc.kill('SIGKILL'); process.exit(1); }
  return { proc, base, port, getLog: () => log };
}

const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
const s = await spawnBackend(TOKEN);
const auth = { 'X-App-Token': TOKEN };
const acao = (res) => res.headers.get('access-control-allow-origin');
try {
  let res = await fetch(`${s.base}/health`);
  check('/health open without token', res.status === 200);
  res = await fetch(`${s.base}/api/cloud/machine_id`);
  check('API without token -> 401', res.status === 401, `${res.status}`);
  res = await fetch(`${s.base}/api/cloud/machine_id`, { headers: { 'X-App-Token': 'wrong' } });
  check('API with wrong token -> 401', res.status === 401, `${res.status}`);
  res = await fetch(`${s.base}/api/cloud/machine_id`, { headers: { 'X-App-Token': TOKEN + 'x' } });
  check('API with token + suffix -> 401 (length-safe compare)', res.status === 401, `${res.status}`);
  res = await fetch(`${s.base}/api/cloud/machine_id`, { headers: auth });
  check('API with correct token -> 200', res.status === 200 && typeof (await res.json()).machine_id === 'string', `${res.status}`);
  res = await fetch(`${s.base}/api/workflow/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('workflow execute without token -> 401', res.status === 401, `${res.status}`);
  res = await fetch(`${s.base}/api/cloud/pending`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-app-token' } });
  check('CORS preflight passes without token', res.status < 400 && acao(res) === 'http://localhost:5173', `${res.status} acao=${acao(res)}`);

  res = await fetch(`${s.base}/health`, { headers: { Origin: 'https://evil.example' } });
  check('foreign Origin: no Access-Control-Allow-Origin', acao(res) === null, `acao=${acao(res)}`);
  res = await fetch(`${s.base}/health`, { headers: { Origin: 'null' } });
  check('Origin null (packaged renderer): reflected', acao(res) === 'null', `acao=${acao(res)}`);
  res = await fetch(`${s.base}/health`, { headers: { Origin: 'http://127.0.0.1:5173' } });
  check('Origin 127.0.0.1:5173 (dev): reflected', acao(res) === 'http://127.0.0.1:5173', `acao=${acao(res)}`);

  // Bound to loopback only
  check('startup log announces 127.0.0.1', /127\.0\.0\.1/.test(s.getLog()) && !/0\.0\.0\.0/.test(s.getLog()));
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (lan) {
    const refused = await new Promise((resolve) => {
      const sock = net.connect({ host: lan.address, port: s.port });
      sock.once('connect', () => { sock.destroy(); resolve(false); });
      sock.once('error', () => resolve(true));
      setTimeout(() => { sock.destroy(); resolve(true); }, 2000);
    });
    check(`not reachable via non-loopback interface ${lan.address}`, refused);
  } else {
    check('no non-loopback interface to probe (skipped)', true);
  }

  // Queue cap
  const post = (p, body) => fetch(`${s.base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(body) });
  for (let i = 0; i < 620; i++) {
    await post('/api/cloud/receive', { document: { id: i, title: `d${i}`, ownerId: 'someone-else' }, sender_id: 'peer' });
  }
  res = await fetch(`${s.base}/api/cloud/pending?machine_id=me`, { headers: auth });
  const pending = await res.json();
  check('pending document queue capped at 500 (oldest dropped)',
    pending.pending_documents.length === 500 && pending.pending_documents[0].id === 120, `${pending.pending_documents.length} first=${pending.pending_documents[0] && pending.pending_documents[0].id}`);

  // Peer address validation + SSRF guard on broadcast
  res = await post('/api/cloud/broadcast', { document: { id: 1, title: 't' }, peer_ips: ['evil.example/x?y', '127.0.0.1:8080', '10.0.0.1'] });
  const bc = await res.json();
  const errs = (bc.broadcast_results || []).map((r) => `${r.peer}:${r.success}:${r.error || ''}`);
  check('broadcast: malformed peer rejected', errs.some((e) => e.startsWith('evil.example/x?y:false') && /Invalid peer/.test(e)), errs.join(' | '));
  check('broadcast: loopback peer rejected by SSRF guard', errs.some((e) => e.startsWith('127.0.0.1:8080:false') && /not allowed/.test(e)), errs.join(' | '));
  // Private peers are allowed by the default workflow policy (intranet use);
  // the unroutable 10.0.0.1 must therefore fail on CONNECT, not on the guard.
  check('broadcast: private peer passes the guard by default (fails on connect, not "not allowed")', errs.some((e) => e.startsWith('10.0.0.1:false') && !/not allowed/.test(e)), errs.join(' | '));

  // Workflow REST node refuses internal URL
  const wf = {
    nodes: [
      { id: 'b', type: 'beginplay', data: { inputs: {} } },
      { id: 'h', type: 'restapi', data: { url: 'http://169.254.169.254/latest/meta-data/', method: 'GET' } },
      { id: 'r', type: 'result', data: {} }
    ],
    edges: [
      { source: 'b', target: 'h', type: 'execution', sourceHandle: 'exec-out', targetHandle: 'exec-in' },
      { source: 'h', target: 'r', type: 'execution', sourceHandle: 'exec-out', targetHandle: 'exec-in' },
      { source: 'h', target: 'r', type: 'data', sourceHandle: 'data-out', targetHandle: 'data-in' }
    ]
  };
  res = await post('/api/workflow/execute', { workflow: wf, inputs: {} });
  const wfBody = await res.json();
  check('workflow REST node to link-local metadata refused', res.status === 500 && /not allowed/.test(wfBody.error || ''), `${res.status} ${wfBody.error}`);
} catch (error) {
  check('unexpected error', false, error.stack || String(error));
} finally {
  s.proc.kill('SIGTERM');
}

// Fail closed without a token
const s2 = await spawnBackend(null);
try {
  check('no token: warning logged', /APP_AUTH_TOKEN is not set/.test(s2.getLog()));
  let res = await fetch(`${s2.base}/health`);
  check('no token: /health still 200', res.status === 200);
  res = await fetch(`${s2.base}/api/cloud/machine_id`);
  check('no token: API -> 500 (fail closed)', res.status === 500, `${res.status}`);
  res = await fetch(`${s2.base}/api/cloud/machine_id`, { headers: { 'X-App-Token': '' } });
  check('no token: empty header -> 500', res.status === 500, `${res.status}`);
} finally {
  s2.proc.kill('SIGTERM');
}

const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
