/**
 * A stand-in for the console's Caddy in tests: one origin that forwards
 * `/central/*` (prefix stripped, websockets included) to a jacarium-central
 * server and everything else to the home server's backend (or answers 404
 * when there is none). The app derives `<origin>/central` from the backend's
 * capabilities and connects its Socket.IO at `/central/socket.io`, exactly as
 * it does against the real deployment (deploy/Caddyfile).
 *
 *   const proxy = await startConsoleProxy({ centralUrl, backendUrl });
 *   proxy.url      // http://127.0.0.1:<port>
 *   await proxy.close();
 *
 * Plain Node (http + net), no dependencies; loopback only.
 */
import http from 'node:http';
import net from 'node:net';

const parse = (url) => { const u = new URL(url); return { host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) }; };

export async function startConsoleProxy({ centralUrl, backendUrl = null, prefix = '/central' }) {
  const central = parse(centralUrl);
  const backend = backendUrl ? parse(backendUrl) : null;
  const route = (path) => {
    if (path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)) {
      const rest = path.slice(prefix.length) || '/';
      return { target: central, path: rest.startsWith('/') ? rest : `/${rest}` };
    }
    return backend ? { target: backend, path } : null;
  };

  const server = http.createServer((req, res) => {
    const r = route(req.url);
    if (!r) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not found"}'); return; }
    const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress || '127.0.0.1', 'x-forwarded-proto': 'http' };
    const upstream = http.request({ host: r.target.host, port: r.target.port, method: req.method, path: r.path, headers }, (ures) => {
      res.writeHead(ures.statusCode || 502, ures.headers);
      ures.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('upstream error'); });
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    const r = route(req.url);
    if (!r) { socket.destroy(); return; }
    const target = net.connect(r.target.port, r.target.host, () => {
      const lines = [`${req.method} ${r.path} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      lines.push(`X-Forwarded-For: ${req.socket.remoteAddress || '127.0.0.1'}`);
      target.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, server, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
