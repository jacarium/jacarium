#!/usr/bin/env node

/**
 * Jacarium central server
 *
 * The relay and store behind the team features: shared documents, workflows,
 * kanban boards, chat and the games, between the devices of a home server's
 * accounts (it runs inside the console container, behind /central).
 *
 * Usage:
 *   node server.js [port]
 *
 * Default port: 3000
 *
 * Environment Variables:
 *   PORT - Server port (default: 3000)
 *   CORS_ORIGIN - CORS allowed origin (default: *)
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const {
  PORT,
  HOST,
  CORS_ORIGIN,
  USE_HTTPS,
  TRUST_PROXY,
  ENROLLMENT_SECRET,
  SSL_KEY,
  SSL_CERT,
  debugLog,
  messageQueue,
  pruneStaleMachines,
  setIoInstance
} = require('./state');
const { sweepStaleGames, GAME_CLEANUP_INTERVAL_MS } = require('./game-registry');
const apiRouter = require('./api-routes');
const { registerSocketHandlers } = require('./socket-handlers');
const { buildCorsOrigin } = require('./cors-policy');
const { flushAllDocuments } = require('./yjs-sync');
const { isAccountAuthEnabled } = require('./account-tickets');
const { isPairingClosed } = require('./client-registry');

const app = express();
if (TRUST_PROXY) {
  app.set('trust proxy', 1);
}

// Cleanup old messages (30 minutes timeout)
const MESSAGE_TIMEOUT_MS = 30 * 60 * 1000;
// A machine that has not connected or polled for this long is no longer
// counted as active (its queued messages expire on the same horizon).
const STALE_MACHINE_MS = MESSAGE_TIMEOUT_MS;

setInterval(() => {
  const now = Date.now();

  // Clean up old document messages
  messageQueue.documents = messageQueue.documents.filter(msg => {
    if (now - msg.timestamp > MESSAGE_TIMEOUT_MS) {
      debugLog(`[Cleanup] Removing expired document message ${msg.id}`);
      return false;
    }
    return true;
  });

  // Clean up old workflow messages
  messageQueue.workflows = messageQueue.workflows.filter(msg => {
    if (now - msg.timestamp > MESSAGE_TIMEOUT_MS) {
      debugLog(`[Cleanup] Removing expired workflow message ${msg.id}`);
      return false;
    }
    return true;
  });

  // Clean up old kanban board messages
  messageQueue.kanbanBoards = messageQueue.kanbanBoards.filter(msg => {
    if (now - msg.timestamp > MESSAGE_TIMEOUT_MS) {
      debugLog(`[Cleanup] Removing expired kanban board message ${msg.id}`);
      return false;
    }
    return true;
  });

  // Clean up old task instance messages
  messageQueue.taskwarriorInstances = messageQueue.taskwarriorInstances.filter(msg => {
    if (now - msg.timestamp > MESSAGE_TIMEOUT_MS) {
      debugLog(`[Cleanup] Removing expired task instance message ${msg.id}`);
      return false;
    }
    return true;
  });

  // Forget machines that are neither connected nor polling any more, so
  // they stop holding every queued message "undelivered" and the set does
  // not grow forever (see ActiveMachines in state.js).
  const pruned = pruneStaleMachines(STALE_MACHINE_MS, now);
  if (pruned.length > 0) {
    console.log(`[Cleanup] Pruned ${pruned.length} stale machine(s): ${pruned.join(', ')}`);
  }
}, 60000); // Run cleanup every minute

// Middleware
// CORS: an explicit CORS_ORIGIN is honored verbatim ('*', one origin, or a
// comma-separated list). When unset, only the desktop app's own origins are
// admitted (see cors-policy.js) instead of the old wildcard.
const corsPolicy = buildCorsOrigin(CORS_ORIGIN);
if (!corsPolicy.configured) {
  console.log('[CORS] CORS_ORIGIN not set - allowing desktop-app origins only (file://, null, localhost). '
    + 'Set CORS_ORIGIN to allow browser clients from other origins.');
}
app.use(cors({ origin: corsPolicy.origin }));
// express.json is body-parser's JSON parser (the separate package is gone with Express 5)
app.use(express.json({ limit: '50mb' }));
// Express 5 leaves req.body undefined when nothing was parsed (4 set {}); the
// routes destructure it, so keep the old shape
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// Logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  debugLog(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  debugLog(`[${timestamp}] ${req.method} ${req.path}`);
  if (req.query && Object.keys(req.query).length > 0) {
    debugLog(`  Query:`, req.query);
  }
  next();
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// REST API routes and static game-page routes (mounted at '/', paths unchanged)
app.use(apiRouter);

// Errors reach here: a body the JSON parser refuses (400, or 413 over the
// limit), and - new with Express 5 - a throw or a rejected promise in a
// handler. Always JSON, with the error's own status; never Express's default
// HTML page, which carries the stack trace.
// eslint-disable-next-line no-unused-vars -- Express selects the error handler by its four parameters
app.use((err, req, res, next) => {
  const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error('[Server] Unhandled error:', (err && err.stack) || err);
  const message = status >= 500 ? 'Internal server error'
    : err.type === 'entity.parse.failed' ? 'Malformed JSON body'
      : err.type === 'entity.too.large' ? 'Request body too large'
        : (err.expose && err.message) || 'Bad request';
  res.status(status).json({ error: message });
});

// ============================================================================
// Start Server
// ============================================================================

// Start server (HTTP or HTTPS)
function startServer() {
  let server;

  if (USE_HTTPS) {
    // Check if certificates exist
    if (!fs.existsSync(SSL_KEY) || !fs.existsSync(SSL_CERT)) {
      console.error('');
      console.error('═══════════════════════════════════════════════════');
      console.error('  ERROR: SSL Certificates Not Found');
      console.error('═══════════════════════════════════════════════════');
      console.error(`  Key file: ${SSL_KEY}`);
      console.error(`  Cert file: ${SSL_CERT}`);
      console.error('');
      console.error('  To generate self-signed certificates:');
      console.error('  ./generate-certs.sh');
      console.error('  (or point CERT_PATH at a directory holding key.pem + cert.pem)');
      console.error('');
      console.error('  Or disable HTTPS by setting USE_HTTPS=false');
      console.error('═══════════════════════════════════════════════════');
      console.error('');
      process.exit(1);
    }

    // Load SSL certificates
    const options = {
      key: fs.readFileSync(SSL_KEY),
      cert: fs.readFileSync(SSL_CERT)
    };

    server = https.createServer(options, app);
  } else {
    server = http.createServer(app);
  }

  // Initialize Socket.IO
  const io = new Server(server, {
    cors: {
      origin: corsPolicy.origin,
      methods: ['GET', 'POST']
    },
    // Ping/pong heartbeat configuration to prevent disconnections
    pingTimeout: 60000,     // How long to wait for pong response (60s)
    pingInterval: 25000,    // How often to send ping (25s)
    upgradeTimeout: 30000,  // How long to wait for upgrade
    allowEIO3: true         // Compatibility
  });

  // Store io instance globally for Grid game broadcasts
  setIoInstance(io);

  // WebSocket connection handling
  registerSocketHandlers(io);

  // Periodic cleanup task for stale games. Games are only removed once ALL
  // their players have been disconnected for a grace period (the
  // reconnection window), plus ended/empty-game pruning - see
  // sweepStaleGames() in game-registry.js. The old inline sweep here keyed
  // off game AGE (createdAt), which deleted any game older than a minute
  // within seconds of its last player leaving and made reconnection
  // impossible.
  setInterval(() => sweepStaleGames(), GAME_CLEANUP_INTERVAL_MS);

  server.listen(PORT, HOST, () => {
    const protocol = USE_HTTPS ? 'https' : 'http';
    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('  Jacarium central server');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  Status: Running`);
    console.log(`  Protocol: ${protocol.toUpperCase()}`);
    console.log(`  Port: ${PORT}`);
    console.log(`  URL: ${protocol}://${HOST}:${PORT}`);
    console.log(`  CORS: ${corsPolicy.configured ? CORS_ORIGIN : 'desktop-app origins only (CORS_ORIGIN not set)'}`);
    console.log(`  Account sign-in: ${isAccountAuthEnabled() ? 'accepted (ACCOUNT_TICKET_KEY set: signed-in users of the home server are recognised by ticket)' : 'not accepted (no ACCOUNT_TICKET_KEY: development / test server)'}`);
    console.log(`  Pairing: ${isPairingClosed() ? 'closed (account sign-in only)' : ENROLLMENT_SECRET ? 'gated (ENROLLMENT_SECRET set)' : 'OPEN (ENROLLMENT_SECRET not set)'}`);
    console.log(`  Behind a proxy: ${TRUST_PROXY ? 'yes (TRUST_PROXY=1, client addresses from X-Forwarded-For)' : 'no'}`);
    if (!ENROLLMENT_SECRET && !isAccountAuthEnabled()) {
      console.log('  [WARNING] no ACCOUNT_TICKET_KEY and no ENROLLMENT_SECRET: any previously-unseen machine_id can');
      console.log('            self-register and receive all synced data. Fine for a development server on');
      console.log('            loopback; a deployment runs behind the home server with a ticket key.');
    } else if (ENROLLMENT_SECRET && !USE_HTTPS && !TRUST_PROXY) {
      console.log('  [WARNING] ENROLLMENT_SECRET is set but USE_HTTPS is false: the enrollment secret');
      console.log('            (and client secrets) cross the network in cleartext. Enable HTTPS.');
    }
    if (USE_HTTPS) {
      console.log(`  SSL Key: ${SSL_KEY}`);
      console.log(`  SSL Cert: ${SSL_CERT}`);
    }
    console.log('');
    console.log('  WebSocket Events:');
    console.log('    authenticate - Register machine ID');
    console.log('    upload-document - Upload document');
    console.log('    upload-workflow - Upload workflow');
    console.log('    upload-board - Upload kanban board');
    console.log('    remove-document - Remove document');
    console.log('    remove-workflow - Remove workflow');
    console.log('    remove-board - Remove kanban board');
    console.log('    chat-message - Send chat message');
    console.log('    connected-users - Broadcast connected users (auto)');
    console.log('');
    console.log('  HTTP Endpoints (legacy):');
    console.log('    GET  /api/health - Health check');
    console.log('    GET  /api/stats - Server statistics');
    console.log('═══════════════════════════════════════════════════');
    console.log('');
  });
}

// ============================================================================
// Graceful shutdown
// ============================================================================
// There was no shutdown handling before this (a SIGTERM/SIGINT simply killed
// the process), so exiting via process.exit() preserves prior behavior for
// everything else - the only addition is flushing every in-memory Yjs
// document to its encrypted on-disk snapshot first, so a deliberate
// restart/redeploy can't lose edits that were still inside the persistence
// debounce window. All writes are synchronous, so they complete before exit.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Server] Received ${signal} - flushing Yjs documents before exit...`);
  try {
    const flushed = flushAllDocuments(`graceful shutdown (${signal})`);
    console.log(`[Server] Flushed ${flushed} Yjs document snapshot(s) to disk`);
  } catch (error) {
    console.error('[Server] Error flushing Yjs documents during shutdown:', error.message);
  }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Defense-in-depth for anything a per-handler guard didn't anticipate. The
// known-dangerous paths (malformed Yjs sync/update messages) are now validated
// and try/caught at the source in yjs-sync.js, so a single bad message no
// longer reaches here. But if some OTHER unguarded throw escapes a socket
// callback, Node's default is to hard-exit WITHOUT flushing in-flight Yjs
// documents (losing edits still inside the persistence debounce window).
//
// We deliberately do NOT swallow-and-continue: once an exception has unwound
// through unknown code, in-memory Y.Doc state may be half-mutated, and quietly
// resuming would let a PM2/systemd respawn mask a real bug while serving
// subtly-corrupt data. Instead we log the error loudly, flush what we can, and
// exit non-zero - the same durability guarantee as a signal, but visible.
function handleFatal(kind, error) {
  console.error(`[Server] FATAL ${kind}:`, error && error.stack ? error.stack : error);
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const flushed = flushAllDocuments(`fatal ${kind}`);
    console.error(`[Server] Flushed ${flushed} Yjs document snapshot(s) to disk before exit`);
  } catch (flushError) {
    console.error('[Server] Error flushing Yjs documents during fatal handler:', flushError.message);
  }
  process.exit(1);
}
process.on('uncaughtException', (error) => handleFatal('uncaughtException', error));
process.on('unhandledRejection', (reason) => handleFatal('unhandledRejection', reason));

startServer();
