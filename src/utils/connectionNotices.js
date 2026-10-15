/**
 * When the central server's connection reports (src/utils/cloudWebSocket.js
 * onConnectionStatusChange) deserve a "Working Offline" / "Back Online"
 * notification. The first report on subscribing is "not connected yet"
 * while the socket is still connecting, so only a connection that was up and
 * dropped is "offline", and only a reconnect after such a drop is "back".
 * A server that is never reached stays silent (the status indicator shows it).
 *
 * One tracker for the whole app (src/hooks/useConnectionNotices.js, from the
 * main shell): a drop seen on one page is answered by "Back Online" whichever
 * page is open when the connection returns.
 */
export function createConnectionNoticeTracker() {
  let last = null;            // null until the first report
  let everConnected = false;

  /** 'offline' | 'online' | null for the reported state. */
  return function next(connected) {
    const wasOnline = last === true;
    const wasDropped = last === false && everConnected;
    last = connected;
    if (connected) everConnected = true;
    if (!connected && wasOnline) return 'offline';
    if (connected && wasDropped) return 'online';
    return null;
  };
}
