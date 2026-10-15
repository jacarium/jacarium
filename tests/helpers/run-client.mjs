/**
 * jsdom bootstrap for one simulated app instance (one "machine").
 * Sets up browser globals + fake IndexedDB, then loads the bundled real app
 * client (built by cloud-upload-live-sync.test.mjs). Controlled over stdin.
 */
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto'; // defines globalThis.indexedDB / IDBKeyRange

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

const { window } = dom;

const define = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    try { globalThis[name] = value; } catch { /* ignore */ }
  }
};

define('window', window);
define('document', window.document);
define('navigator', window.navigator);
define('HTMLElement', window.HTMLElement);
define('HTMLTextAreaElement', window.HTMLTextAreaElement);
define('HTMLInputElement', window.HTMLInputElement);
define('Element', window.Element);
define('Node', window.Node);
define('Event', window.Event);
define('KeyboardEvent', window.KeyboardEvent);
define('MouseEvent', window.MouseEvent);
define('CustomEvent', window.CustomEvent);
define('MutationObserver', window.MutationObserver);
define('DOMParser', window.DOMParser);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('localStorage', window.localStorage);
define('sessionStorage', window.sessionStorage);
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('cancelAnimationFrame', (id) => clearTimeout(id));

class FakeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
define('ResizeObserver', FakeObserver);
define('IntersectionObserver', FakeObserver);
window.ResizeObserver = FakeObserver;
window.IntersectionObserver = FakeObserver;

// jsdom misses these layout-ish APIs
window.HTMLElement.prototype.scrollIntoView = function () {};
window.HTMLElement.prototype.scrollTo = function () {};
window.matchMedia = window.matchMedia || ((q) => ({
  matches: false, media: q,
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, dispatchEvent() { return false; },
}));

// IndexedDB into the jsdom window too (Dexie may look on window/self)
window.indexedDB = globalThis.indexedDB;
window.IDBKeyRange = globalThis.IDBKeyRange;

// Optional textarea geometry stubs (jsdom has no layout engine, so clientWidth/
// clientHeight are always 0 and scrollTop is inert). When TA_CLIENT_WIDTH is
// set, give textareas a fixed viewport size and a functional scrollTop/
// scrollLeft so tests can exercise soft-wrap math and viewport culling
// (see tests/collab-cursor-rendering.test.mjs). Unset = behavior unchanged.
if (process.env.TA_CLIENT_WIDTH) {
  const proto = window.HTMLTextAreaElement.prototype;
  Object.defineProperty(proto, 'clientWidth', {
    configurable: true,
    get() { return Number(process.env.TA_CLIENT_WIDTH); },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get() { return Number(process.env.TA_CLIENT_HEIGHT || 400); },
  });
  for (const prop of ['scrollTop', 'scrollLeft']) {
    const key = `__stub_${prop}`;
    Object.defineProperty(proto, prop, {
      configurable: true,
      get() { return this[key] || 0; },
      set(v) { this[key] = v; },
    });
  }

  // Emulate soft-wrap LAYOUT for the editor's hidden measuring divs (the gutter
  // line-height mirror in gutterLineLayout.js and the search-highlight measure
  // div): a <span> inside a pre-wrap <div> gets a rect derived from the text
  // before it, wrapping every charsPerRow characters (TA_CLIENT_WIDTH / 8.4px,
  // the editor's fallback char width in jsdom) at 22.4px per row. The editor
  // measures real layout instead of estimating, so without this jsdom's all-zero
  // rects would make every line one row. Everything else keeps jsdom's zeros.
  const LINE_H = 22.4;
  const CHAR_W = 8.4;
  const charsPerRow = Math.max(1, Math.floor(Number(process.env.TA_CLIENT_WIDTH) / CHAR_W));
  const origRect = window.Element.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const parent = this.parentElement;
    if (this.tagName === 'SPAN' && parent && parent.tagName === 'DIV' && parent.style.whiteSpace === 'pre-wrap') {
      let rows = 0;
      let col = 0;
      for (let n = parent.firstChild; n && n !== this; n = n.nextSibling) {
        if (n.nodeType !== 3) continue;
        const parts = n.nodeValue.split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) { rows += Math.max(1, Math.ceil(col / charsPerRow)); col = 0; }
          col += parts[i].length;
        }
      }
      const top = (rows + Math.floor(col / charsPerRow)) * LINE_H;
      const left = (col % charsPerRow) * CHAR_W;
      return { top, left, bottom: top + LINE_H, right: left, width: 0, height: LINE_H, x: left, y: top, toJSON() { return this; } };
    }
    return origRect.call(this);
  };
}

// The Electron preload surface of a desktop profile LINKED to a home server
// (electron/home-server.cjs through electron/preload.cjs): the main process
// answers for the home server here. The team features come with the home
// server (src/utils/cloudCentralSync.js): /api/version announces the central
// server at /central, /api/auth/central-ticket mints the account ticket with
// ACCOUNT_TICKET_KEY (the key the spawned central server was started with),
// and every /central/* request goes to a console-like proxy in this process
// (tests/helpers/central-proxy.mjs) that forwards to SERVER_URL - websockets
// included, so the app's socket at <home>/central/socket.io works as it
// does against the real deployment. MACHINE_ID is the account identity
// (`<user>@account-<tag>`), as the ticket names it.
const MACHINE_ID = process.env.MACHINE_ID || 'tester@account-test';
const USERNAME = MACHINE_ID.split('@')[0];
const USER_TAG = (MACHINE_ID.split('@account-')[1] || 'test');
const TICKET_KEY = process.env.ACCOUNT_TICKET_KEY || '';
const { startConsoleProxy } = await import('./central-proxy.mjs');
const home = process.env.SERVER_URL ? await startConsoleProxy({ centralUrl: process.env.SERVER_URL }) : null;
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function mintTicket() {
  const now = Math.floor(Date.now() / 1000);
  const payload = { exp: now + 600, iat: now, iss: 'jacarium-home', mid: MACHINE_ID, n: process.env.DISPLAY_NAME || '', sub: USER_TAG, u: USERNAME };
  const body = b64url(JSON.stringify(payload));
  const sig = (await_crypto()).createHmac('sha256', Buffer.from(TICKET_KEY, 'hex')).update(`v1.${body}`).digest();
  return { ticket: `v1.${body}.${b64url(sig)}`, expiresAt: payload.exp, identity: MACHINE_ID };
}
const nodeCrypto = await import('node:crypto');
function await_crypto() { return nodeCrypto; }
const answer = (body, status = 200) => ({ ok: status < 300, status, text: JSON.stringify(body) });
window.electronAPI = {
  getMachineIdOverride: async () => MACHINE_ID,
  getUsername: async () => 'testuser',
  getHostname: async () => 'testhost',
  homeServerStatus: async () => (home ? { linked: true, url: home.url, userId: USER_TAG, username: USERNAME, displayName: process.env.DISPLAY_NAME || '', deviceName: 'test device', encrypted: true } : { linked: false }),
  homeServerLink: async () => { throw new Error('not in this test'); },
  homeServerUnlink: async () => ({ linked: false }),
  homeServerVersion: async () => ({ reachable: !!home, linked: !!home, url: home?.url || null, app: process.env.APP_VERSION || '0.0.0', protocol: 2, legacy: false, error: null }),
  homeServerFetch: async (pathName, init = {}) => {
    if (!home) return answer({ error: 'Not linked to a home server' }, 0);
    if (pathName === '/api/version') return answer({ app: process.env.APP_VERSION || '0.0.0', protocol: 2, capabilities: { central: { provided: true, path: '/central', accountSignIn: true } } });
    if (pathName === '/api/auth/central-ticket') return TICKET_KEY ? answer(mintTicket()) : answer({ error: 'no key', code: 'ACCOUNT_SIGN_IN_NOT_ACCEPTED' }, 409);
    if (pathName === '/api/auth/me') return answer({ user: { id: USER_TAG, username: USERNAME, displayName: process.env.DISPLAY_NAME || '', role: 'user' } });
    if (!pathName.startsWith('/central/')) return answer({ error: 'not found' }, 404);
    const r = await fetch(`${home.url}${pathName}`, { method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    return { ok: r.ok, status: r.status, text: await r.text() };
  },
};

// Seed app settings BEFORE app modules load
window.localStorage.setItem('cloudSyncEnabled', 'true');
window.localStorage.setItem('expandedDocumentCategories', JSON.stringify(['General']));

if (!process.env.CLIENT_BUNDLE) throw new Error('CLIENT_BUNDLE env var not set');
await import(process.env.CLIENT_BUNDLE);
