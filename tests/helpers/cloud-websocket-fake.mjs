/**
 * A stand-in for src/utils/cloudWebSocket.js in jsdom tests of the Yjs
 * editor (tests/ai-context-yjs-live.test.mjs, through setupDocumentsEnv's
 * `stubs`): a socket object with the surface the Yjs provider uses (on /
 * off / emit), never connected, so useYjsText takes its offline path - it
 * creates the provider, gets no sync-step2, and after its 3 s fallback
 * seeds the Yjs text from the local copy. `emitted` records what the
 * provider sent; `fire(event, payload)` delivers a server message.
 */
const handlers = new Map();
export const emitted = [];
export const fakeSocket = {
  connected: false,
  id: 'fake-socket',
  on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); return this; },
  off(event, fn) { handlers.get(event)?.delete(fn); return this; },
  emit(event, payload) { emitted.push({ event, payload }); return this; },
};
export function fire(event, payload) { for (const fn of handlers.get(event) || []) fn(payload); }

export function getSocket() { return fakeSocket; }
export function isWebSocketConnected() { return false; }
export function onConnectionStatusChange() { return () => {}; }
export function getConnectedUsers() { return []; }
const noop = () => () => {};
export const onDocumentsUpdate = noop;
export const onWorkflowsUpdate = noop;
export const onBoardsUpdate = noop;
export const onCursorsUpdate = noop;
export const onContentUpdate = noop;
export const onChatMessage = noop;
export const onConnectedUsersUpdate = noop;
export async function connectWebSocket() { return false; }
export function disconnectWebSocket() {}
export async function sendCursorUpdate() {}
export async function sendDisplayNameUpdate() {}
export async function sendCursorRemoved() {}
export async function sendContentUpdate() {}
export async function uploadDocumentViaWebSocket() { return false; }
export async function removeDocumentViaWebSocket() { return false; }
