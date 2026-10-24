import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { FileText, FolderOpen, Loader, AlertCircle, X, ChevronRight, Monitor, ListChecks, Cpu, Server, Gauge, Settings, Cloud, HardDrive, Layers, PieChart, Network, TrendingUp, GitFork, BarChart, MemoryStick, AlertTriangle, Hourglass, Skull, Bell, Box, Briefcase, Boxes } from 'lucide-react';
// import Breadcrumbs from './Breadcrumbs'; // Commented out - can be restored later
import ResizableSidebar from './ResizableSidebar';
import { useMobile } from '../contexts/MobileContext';
import MobilePageHeader from './mobile/MobilePageHeader';
import DiagnosticsSidebar from './features/diagnostics/DiagnosticsSidebar';
import BrowseDirectoryModal from './features/diagnostics/BrowseDirectoryModal';
import { buildDiagnosticsFrameStyles } from './features/diagnostics/diagnosticsFrameStyles';
import LoadingGame from './LoadingGame';
import { getBackendUrl, apiFetch } from '../utils/backendUrl';
import { onBackendInfo } from '../utils/platform';
// Relative path on purpose: chart.js's package "exports" map does not expose
// dist/chart.umd.js, so the bare specifier cannot be resolved by Vite.
import chartUmdSource from '../../node_modules/chart.js/dist/chart.umd.js?raw';
// The shared frame script (the busy state and the chart helper every plugin uses): one file, inlined into every
// tab's frame after Chart.js and the theme bridge; the standalone Flask dashboard links the same file.
import diagnosticsUiSource from '../../backend/static/diagnostics-ui.js?raw';

// The app's current theme, read LIVE from the DOM: ThemeContext toggles the
// `dark` class on <html> and sets data-theme / data-dark-variant /
// data-gradient (src/contexts/ThemeContext.jsx); the os-* tokens are defined
// on those selectors. Reading it at the moment we need it avoids stale
// snapshots (e.g. a value captured during render before ThemeContext's own
// effect has applied the class on a page reload / session restore). The
// whole set is mirrored onto the frame's <html> so the tokens resolve inside
// the frame exactly as outside (Jacaranda violet vs neutral grey, light).
function appTheme() {
  if (typeof document === 'undefined') return { dark: false, theme: null, darkVariant: null, gradient: null, vars: {} };
  const root = document.documentElement;
  // the custom properties set inline on <html> (a runtime override of a token, e.g. --btn-primary-bg): the frame gets them too
  const vars = {};
  for (let i = 0; i < root.style.length; i++) { const n = root.style[i]; if (n.startsWith('--')) vars[n] = root.style.getPropertyValue(n); }
  return {
    dark: root.classList.contains('dark'),
    theme: root.getAttribute('data-theme'),
    darkVariant: root.getAttribute('data-dark-variant'),
    gradient: root.getAttribute('data-gradient'),
    vars,
  };
}

const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Build a full HTML document for the sandboxed diagnostics iframe.
//
// The fragment returned by POST /load_tab is UNTRUSTED: it is rendered from
// report files (hostnames, log lines, config values) and historically
// had its <script> tags executed with full renderer privileges. That gave any
// unescaped file-derived content arbitrary code execution and access to
// window.electronAPI (env-file secrets, SSH/command-exec token).
//
// We now render it inside an <iframe sandbox="allow-scripts" srcdoc> WITHOUT
// allow-same-origin. Per the HTML spec that frame gets an opaque, unique
// origin: its scripts still execute (needed for the sortable tables,
// pagination and Chart.js graphs ~19 templates rely on), but they cannot reach
// the parent window/document, cookies, storage, or window.electronAPI. Because
// nodeIntegrationInSubFrames is unset (defaults false) and contextIsolation is
// on, the preload bridge never attaches to sub-frames anyway.
// The templates expect a global window.Chart: ~15 of them call
// `new Chart(...)` without loading Chart.js themselves (historically the app
// loaded it globally from a CDN in index.html). Each sandboxed iframe is an
// isolated context that does NOT inherit the parent's globals, so Chart.js
// must be provided inside the frame. It is INLINED from the bundled chart.js
// package (Vite `?raw` import) rather than referenced by URL: the app must
// work without internet access (no CDN), and a
// srcdoc frame with an opaque origin resolves relative URLs against the
// parent document (file:// in the packaged app), which is not a reliable
// place to serve a script from. It must be a classic, render-blocking
// <script> in <head> so Chart exists before the templates' inline body
// scripts run at parse time (defer/async would run too late).
// tests/no-remote-assets.test.mjs checks the source contains no "</script"
// that would terminate this inline tag early.
function getDiagnosticsChartScriptTag() {
  return `<script>${chartUmdSource}</script>`;
}
function getDiagnosticsUiScriptTag() {
  return `<script>${diagnosticsUiSource}</script>`;
}

// Normalize a tab fragment before embedding it in the iframe srcdoc.
//
// Some templates ship malformed markup - notably sosreport_pci_devices.html has
// an inline <script> with NO closing </script>. The old dangerouslySetInnerHTML
// path tolerated this because the browser's innerHTML parser auto-closes the
// dangling tag and the code then executed script.textContent. Inside a srcdoc,
// an unclosed <script> instead swallows everything that follows it - including
// our own trailing bootstrap <script> - so the literal "<script>"/"</div>" text
// gets parsed as JavaScript ("Uncaught SyntaxError: Unexpected token '<'").
//
// Re-parsing through an inert <template> (whose content does NOT execute scripts
// or load resources) and re-serializing gives back balanced, well-formed markup
// with every <script> properly closed - exactly the leniency the old path relied
// on - before we hand it to the srcdoc where scripts DO run.
function normalizeFragmentHtml(html) {
  try {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    return tpl.innerHTML;
  } catch {
    return html;
  }
}

// Exactly the backend paths the sandboxed diagnostic templates legitimately
// need the parent to proxy for them (see the postMessage API proxy). Anything
// not listed here is refused - a malicious diagnostic payload must NOT be able
// to reach sensitive authenticated routes (e.g. /api/execute-ssh) through this
// channel. One-shot POSTs vs streamed (SSE) responses are allowlisted separately.
const DIAGNOSTICS_API_ALLOWLIST = new Set(['/get_log_date_range', '/parse_haproxy_log', '/audit_event_body', '/audit_events_search', '/audit_events_cancel']);
const DIAGNOSTICS_API_STREAM_ALLOWLIST = new Set(['/parse_log_viewer_stream']);

function buildDiagnosticsSrcDoc(fragmentHtml, theme) {
  // Reuse the app's own styling so the frame matches the surrounding UI. We do
  // NOT copy <link>/<style> DOM nodes: in a packaged build the compiled Tailwind
  // is a <link href="file://.../assets/index-*.css">, and copying that into the
  // opaque-origin iframe makes the frame try to re-fetch it itself, which
  // Electron blocks ("Not allowed to load local resource" - file:// subresource
  // loads are only permitted for the trusted top-level frame).
  //
  // Instead we serialize the ALREADY-PARSED rules from the parent's
  // document.styleSheets back to text and inline them. No new network/file
  // request happens, so the file:// restriction never applies - identical
  // behavior in dev, prod and packaged builds. This one pass also covers the
  // backend styles.css (injected at mount as <style id="diagnostics-styles">),
  // since <style> elements are represented in document.styleSheets too.
  //
  // The same file:// restriction hits the url() sources inside the parent's
  // @font-face rules (the bundled red-hat-* woff2 files), so those rules are
  // dropped and replaced with data:-URL @font-face rules - see
  // diagnosticsFrameStyles.js.
  const appStyles = buildDiagnosticsFrameStyles(document);

  // Bake the current theme into the frame's own <html> so first paint is
  // correct (no light-mode flash): the `dark` class plus the theme
  // attributes the tokens are keyed on, and a `#diagnostics-content` wrapper
  // (the backend styles.css scopes its rules to it).
  const htmlAttrs = `${theme.dark ? ' class="dark"' : ''}${theme.theme ? ` data-theme="${escapeAttr(theme.theme)}"` : ''}${theme.darkVariant ? ` data-dark-variant="${escapeAttr(theme.darkVariant)}"` : ''}${theme.gradient ? ` data-gradient="${escapeAttr(theme.gradient)}"` : ''}`;

  return `<!doctype html>
<html${htmlAttrs}>
<head>
<meta charset="utf-8">
<style>${appStyles}</style>
<style>
  /* Keep the frame visually transparent so the parent card shows through,
     matching the previous inline-injected rendering (which had no background
     of its own). Overrides any body background copied from the app stylesheet. */
  /* height:auto guarantees <body> hugs its content (never stretches to the
     parent-imposed iframe height), so document.body.scrollHeight is a truthful,
     shrinkable content measure - see reportHeight below. */
  /* overflow:hidden: this frame must NEVER scroll internally - the whole point
     of the height-report mechanism is that the OUTER page scrolls while the
     iframe tracks its content height. During the window before a height report
     lands (initial load, between re-render and the next report) the content
     transiently overflows the iframe's stale, too-small height; without this,
     the frame grows its own vertical scrollbar for that window, and on systems
     with non-overlay scrollbars (Windows, some Linux DEs) its gutter steals
     content width, visibly reflowing the page until the height catches up.
     Templates' intentional inner scroll panels (overflow-auto lists, the Log
     Viewer file list, etc.) are unaffected - this only pins html/body. */
  html, body { margin: 0 !important; padding: 0 !important; background: transparent !important; height: auto !important; overflow: hidden !important; }
</style>
${getDiagnosticsChartScriptTag()}
<script>
(function () {
  // Theme colours for the templates' scripts (Chart.js options): the os-*
  // tokens as the frame's <html> resolves them, so charts follow the app
  // theme like the CSS does. Roles: text (primary), muted (secondary - the
  // chart text), grid (the border token), border, card, surface and tooltip
  // (the secondary card surface). Severity and series colours stay in the
  // templates. The standalone Flask dashboard defines a plain fallback.
  var TOKENS = { text: '--os-text-primary', muted: '--os-text-secondary', grid: '--os-border', border: '--os-border', card: '--os-card', surface: '--os-card-secondary', tooltip: '--os-card-secondary' };
  var cache = {};
  window.diagnosticsThemeColor = function (role) {
    if (cache[role]) return cache[role];
    var value = getComputedStyle(document.documentElement).getPropertyValue(TOKENS[role] || TOKENS.text).trim();
    cache[role] = value || (role === 'grid' || role === 'border' ? '#808080' : role === 'tooltip' || role === 'surface' || role === 'card' ? '#f0f0f0' : '#1f2937');
    return cache[role];
  };
  // Chart.js: the defaults every new chart starts from, and the theme colours
  // of the charts already drawn (axis ticks/grid, legend, title, tooltip -
  // never a dataset's own colour) when the theme changes. Chart text is the
  // primary text token, like the templates ask for themselves.
  function applyThemeToCharts() {
    cache = {};
    var Chart = window.Chart;
    if (!Chart) return;
    var muted = window.diagnosticsThemeColor('text');
    var grid = window.diagnosticsThemeColor('grid');
    Chart.defaults.color = muted;
    Chart.defaults.borderColor = grid;
    var instances = Chart.instances ? Object.values(Chart.instances) : [];
    // chart.options is Chart.js's resolver proxy: reading a missing
    // sub-object returns a proxy over the defaults, and writing that proxy
    // back ("s.ticks = s.ticks || {}") stores a proxy inside the options,
    // which recurses on the next resolve (a stack overflow here, swallowed,
    // and "Recursion detected" / "startsWith is not a function" at the
    // chart's next update, resize or tooltip). So only leaf colours are
    // written, and a sub-object is created only when it truly is absent.
    var sub = function (obj, key) { var v = obj[key]; if (!v) { obj[key] = {}; v = obj[key]; } return v; };
    instances.forEach(function (chart) {
      try {
        var o = chart.options || {};
        if (o.scales) Object.keys(o.scales).forEach(function (k) {
          var s = o.scales[k]; if (!s) return;
          sub(s, 'ticks').color = muted;
          sub(s, 'grid').color = grid;
          if (s.title) s.title.color = muted;
          if (s.pointLabels) s.pointLabels.color = muted;
          if (s.angleLines) s.angleLines.color = grid;
        });
        var p = sub(o, 'plugins');
        sub(sub(p, 'legend'), 'labels').color = muted;
        if (p.title) p.title.color = muted;
        var t = sub(p, 'tooltip');
        t.backgroundColor = window.diagnosticsThemeColor('tooltip');
        t.titleColor = window.diagnosticsThemeColor('text');
        t.bodyColor = window.diagnosticsThemeColor('text');
        t.borderColor = grid;
        chart.update('none');
      } catch (e) { /* a chart mid-destroy: leave it */ }
    });
    // the helper's charts: every series colour and fill resolved again (no black fill after a switch)
    if (window.diagChart && window.diagChart.retheme) { try { window.diagChart.retheme(); } catch (e) { /* a chart mid-destroy */ } }
    return instances.length;
  }
  window.diagnosticsApplyTheme = applyThemeToCharts;
  applyThemeToCharts();
})();
(function () {
  // Authenticated-backend proxy client.
  //
  // The backend gates every request on an X-App-Token header (a per-launch
  // secret). The app's own JS attaches it via window.electronAPI.getAppToken,
  // but this opaque-origin sandboxed frame has NO window.electronAPI, so a few
  // templates' direct fetch() calls went out unauthenticated and got 401s.
  //
  // We do NOT hand the frame the token or a generic "fetch anything" bridge
  // (that would let a malicious diagnostic payload call sensitive routes like
  // /api/execute-ssh). Instead the frame asks the TRUSTED parent to make the
  // call; the parent validates the path against a small allowlist, performs the
  // authenticated fetch, and posts the result back by requestId. Defined here in
  // <head> so it exists before any template body script runs.
  var reqId = 0;
  var pending = {};
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__diagnosticsApi !== true || d.dir !== 'down') return;
    var p = pending[d.requestId];
    if (!p) return;
    if (d.type === 'response') { delete pending[d.requestId]; p.resolve({ ok: d.ok, status: d.status, json: d.json }); }
    else if (d.type === 'error') { delete pending[d.requestId]; p.reject(new Error(d.error || 'Request failed')); }
    else if (d.type === 'chunk') { if (p.onText) { try { p.onText(d.text); } catch (err) {} } }
    else if (d.type === 'end') { delete pending[d.requestId]; p.resolve({ ok: true }); }
  });
  // One-shot authenticated POST. Resolves to { ok, status, json }.
  window.diagnosticsApiRequest = function (path, body) {
    return new Promise(function (resolve, reject) {
      var id = ++reqId;
      pending[id] = { resolve: resolve, reject: reject };
      parent.postMessage({ __diagnosticsApi: true, dir: 'up', type: 'request', requestId: id, path: path, body: body }, '*');
    });
  };
  // Ask the page to show another tab of the same report, e.g. an overview
  // linking to one of its sub-tabs: diagnosticsOpenTab('security', 'csr'). A
  // query is handed to the new page once it is up (diagLinks.applyQuery puts
  // it into the page's [data-ui-search] field): a Findings row's "Open".
  window.diagnosticsOpenTab = function (tab, subTab, query) {
    parent.postMessage({ __diagnosticsApi: true, dir: 'up', type: 'open-tab', tab: tab, subTab: subTab || null, query: query ? String(query).slice(0, 200) : null }, '*');
  };
  // Where the diagnostics pane's viewport lies over this frame. The frame never
  // scrolls (the pane does, and sizes the frame to its content), so a template's
  // sticky header or floating control cannot hold its place on its own: the
  // parent posts the viewport's top (in frame coordinates, negative while the
  // frame starts below it) and height on every scroll and resize; the frame
  // mirrors them into window.diagnosticsViewport, the --frame-view-top /
  // --frame-view-height / --frame-view-bottom custom properties on <html>
  // (--frame-view-bottom clamped to the frame's own height, for a control
  // pinned to the bottom of the view) and a 'diagnosticsviewport' event.
  window.diagnosticsViewport = null;
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__diagnosticsViewport !== true) return;
    var top = Number(d.top) || 0, height = Number(d.height) || 0;
    var bottom = Math.min(top + height, document.documentElement.clientHeight || top + height);
    window.diagnosticsViewport = { top: top, height: height, bottom: bottom };
    var st = document.documentElement.style;
    st.setProperty('--frame-view-top', top + 'px'); st.setProperty('--frame-view-height', height + 'px'); st.setProperty('--frame-view-bottom', bottom + 'px');
    try { window.dispatchEvent(new CustomEvent('diagnosticsviewport', { detail: window.diagnosticsViewport })); } catch (err) { /* no CustomEvent */ }
  });
  // Ask the pane to scroll so that frame coordinate y sits at the top of the view.
  window.diagnosticsScrollTo = function (y) {
    parent.postMessage({ __diagnosticsApi: true, dir: 'up', type: 'scroll-to', y: Number(y) || 0 }, '*');
  };
  // Streamed authenticated POST. onText is called with each decoded text chunk;
  // returns { done: Promise, cancel: fn } so callers can await completion and
  // abort mid-stream (parent cancels the underlying reader).
  window.diagnosticsApiStream = function (path, body, onText) {
    var id = ++reqId;
    var done = new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject, onText: onText }; });
    parent.postMessage({ __diagnosticsApi: true, dir: 'up', type: 'stream-request', requestId: id, path: path, body: body }, '*');
    return {
      done: done,
      cancel: function () { parent.postMessage({ __diagnosticsApi: true, dir: 'up', type: 'stream-abort', requestId: id }, '*'); }
    };
  };
})();
</script>
${getDiagnosticsUiScriptTag()}
</head>
<body>
<div id="diagnostics-content">
${normalizeFragmentHtml(fragmentHtml)}
</div>
<script>
(function () {
  // Report content height to the parent so the OUTER page scrolls as one flow
  // (no nested scrollbar), matching the previous inline-injected behavior.
  var lastHeight = -1;
  function reportHeight() {
    // Measure <body>, NOT document.documentElement: the root element's
    // scrollHeight is floored at the iframe's own (parent-imposed) viewport
    // height, so it can grow but never shrink - leaving the iframe stuck tall
    // after the content shrinks (filtering, pagination, row collapse). <body> is
    // forced to height:auto above, so its scrollHeight tracks the real content
    // in BOTH directions. Fall back to the content wrapper, then documentElement.
    var wrapper = document.getElementById('diagnostics-content');
    var h = (document.body && document.body.scrollHeight)
      || (wrapper && Math.ceil(wrapper.getBoundingClientRect().height))
      || document.documentElement.scrollHeight;
    if (h !== lastHeight) {
      lastHeight = h;
      try {
        parent.postMessage({ __diagnosticsIframe: true, type: 'height', height: h }, '*');
      } catch (e) { /* parent cross-origin postMessage is always permitted */ }
    }
  }
  // Live theme sync: the parent changes the theme on ITS documentElement, which
  // this opaque-origin frame can never observe. The parent postMessages the
  // current theme (the dark class and the attributes the tokens are keyed on)
  // and we mirror it onto our own <html>. That drives the copied CSS (tokens
  // included), the Chart.js re-colouring, and any template's own
  // MutationObserver on the class.
  var loads = 0;
  var appliedVars = [];
  function reportTheme() {
    try {
      var html = document.documentElement;
      var panel = document.querySelector('#diagnostics-content .panel');
      var divider = document.querySelector('#diagnostics-content table tbody tr, #diagnostics-content table thead tr');
      var cs = panel ? getComputedStyle(panel) : null;
      var charts = window.Chart && window.Chart.instances ? Object.values(window.Chart.instances) : [];
      var ticks = [], grids = [];
      charts.forEach(function (c) { Object.values((c.options && c.options.scales) || {}).forEach(function (s) { if (s && s.ticks && s.ticks.color) ticks.push(s.ticks.color); if (s && s.grid && s.grid.color) grids.push(s.grid.color); }); });
      var probe = document.createElement('div'); document.body.appendChild(probe);
      var rgb = function (v) { probe.style.backgroundColor = ''; probe.style.backgroundColor = v; return getComputedStyle(probe).backgroundColor; };
      var report = {
        __diagnosticsThemeApplied: true,
        theme: { dark: html.classList.contains('dark'), theme: html.getAttribute('data-theme'), darkVariant: html.getAttribute('data-dark-variant'), gradient: html.getAttribute('data-gradient') },
        loads: loads,
        card: rgb(window.diagnosticsThemeColor('card')),
        border: rgb(window.diagnosticsThemeColor('border')),
        text: rgb(window.diagnosticsThemeColor('text')),
        panelBackground: cs ? cs.backgroundColor : null,
        panelBorder: cs ? cs.borderTopColor : null,
        panelRadius: cs ? cs.borderTopLeftRadius : null,
        tableDivider: divider ? getComputedStyle(divider).borderBottomColor : null,
        textColor: getComputedStyle(document.getElementById('diagnostics-content') || document.body).color,
        chart: { defaultColor: window.Chart ? rgb(window.Chart.defaults.color) : null, instances: charts.length, tickColors: ticks.map(rgb), gridColors: grids.map(rgb) }
      };
      probe.remove();
      parent.postMessage(report, '*');
    } catch (e) { /* reporting is best effort */ }
  }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__diagnosticsTheme !== true) return;
    var html = document.documentElement;
    var set = function (name, value) { if (value) html.setAttribute(name, value); else html.removeAttribute(name); };
    set('data-theme', d.theme);
    set('data-dark-variant', d.darkVariant);
    set('data-gradient', d.gradient);
    if (d.dark) html.classList.add('dark');
    else html.classList.remove('dark');
    // the inline custom properties of the app's <html>: applied here, the ones gone since removed
    if (d.vars && typeof d.vars === 'object') {
      var names = Object.keys(d.vars);
      appliedVars.forEach(function (n) { if (names.indexOf(n) < 0) html.style.removeProperty(n); });
      names.forEach(function (n) { if (n.indexOf('--') === 0) html.style.setProperty(n, String(d.vars[n])); });
      appliedVars = names;
    }
    if (window.diagnosticsApplyTheme) window.diagnosticsApplyTheme();
    // the templates' own observers run on the class change: re-apply after them
    setTimeout(function () { if (window.diagnosticsApplyTheme) window.diagnosticsApplyTheme(); reportTheme(); reportHeight(); }, 60);
  });
  window.addEventListener('load', function () { loads += 1; setTimeout(function () { if (window.diagnosticsApplyTheme) window.diagnosticsApplyTheme(); reportTheme(); }, 120); });
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () { reportHeight(); });
    ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
  }
  window.addEventListener('load', reportHeight);
  // Catch late async layout changes (Chart.js draws, deferred script bodies).
  var ticks = 0;
  var iv = setInterval(function () { reportHeight(); if (++ticks > 20) clearInterval(iv); }, 250);
  reportHeight();
})();
</script>
</body>
</html>`;
}

export default function DiagnosticsPage() {
  // Restore DiagnosticsPage session from localStorage
  const restoreDiagnosticsSession = () => {
    try {
      const saved = localStorage.getItem('diagnostics-page-session');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (error) {
      console.error('Failed to restore diagnostics session:', error);
    }
    return null;
  };

  const savedSession = restoreDiagnosticsSession();

  const [reportType, setReportType] = useState(savedSession?.reportType || 'sosreport');
  const [directory, setDirectory] = useState(savedSession?.directory || '');
  const [tabs, setTabs] = useState(savedSession?.tabs || []);
  const [expandedTabs, setExpandedTabs] = useState(savedSession?.expandedTabs || []);
  const [activeTab, setActiveTab] = useState(savedSession?.activeTab || null);
  const [activeSubTab, setActiveSubTab] = useState(savedSession?.activeSubTab || null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingTabs, setLoadingTabs] = useState(false);
  const [error, setError] = useState('');
  const [showBrowseDirectory, setShowBrowseDirectory] = useState(false);
  const [backendStatus, setBackendStatus] = useState('checking'); // 'checking', 'online', 'offline'
  const [checkingBackend, setCheckingBackend] = useState(false);
  const [backendBannerDismissed, setBackendBannerDismissed] = useState(false);
  const [availableReports, setAvailableReports] = useState([]);
  const [loadingReports, setLoadingReports] = useState(false);
  const [reportsDirectory, setReportsDirectory] = useState(() => {
    const saved = localStorage.getItem('diagnosticsReportsDirectory');
    return saved || 'Downloads';
  });
  // A backend that restricts browsing to one tree (the container's /data
  // volume: backend/reports_root.py) reports it; browse there, not in a
  // remembered location it would refuse anyway.
  useEffect(() => onBackendInfo((info) => {
    const root = info?.reportsRoot;
    if (root) {
      setReportsDirectory((current) => (current && current.startsWith(root) ? current : root));
    }
  }), []);
  const iframeRef = useRef(null);
  const contentScrollRef = useRef(null);   // the content pane that scrolls over the frame
  const viewportRaf = useRef(0);
  // Latest tabs/loadTab for the iframe message handler (registered once).
  const tabsRef = useRef([]);
  const loadTabRef = useRef(() => {});
  const pendingQueryRef = useRef(null);   // a cross-link's search term for the tab being opened (see open-tab / apply-query)
  // The phone layout: the parser tabs are a drawer under a page header
  const { isMobile } = useMobile();
  const [innerSidebarVisible, setInnerSidebarVisible] = useState(() => {
    const saved = localStorage.getItem('innerSidebarVisible');
    return saved !== null ? JSON.parse(saved) : true;
  });

  // Map FontAwesome icon names to lucide-react components
  const getIconComponent = (iconName) => {
    const iconMap = {
      'fas fa-desktop': Monitor,
      'fas fa-tasks': ListChecks,
      'fas fa-microchip': Cpu,
      'fas fa-server': Server,
      'fas fa-tachometer-alt': Gauge,
      'fas fa-cogs': Settings,
      'fas fa-cloud': Cloud,
      'fas fa-hdd': HardDrive,
      'fas fa-layer-group': Layers,
      'fas fa-folder-open': FolderOpen,
      'fas fa-chart-pie': PieChart,
      'fas fa-network-wired': Network,
      'fas fa-chart-line': TrendingUp,
      'fas fa-project-diagram': GitFork,
      'fas fa-chart-bar': BarChart,
      'fas fa-memory': MemoryStick,
      'fas fa-exclamation-triangle': AlertTriangle,
      'fas fa-hourglass-half': Hourglass,
      'fas fa-skull-crossbones': Skull,
      'fas fa-bell': Bell,
      'fas fa-box': Box,
      'fas fa-briefcase': Briefcase,
      'fas fa-cubes': Boxes,
      'fas fa-cube': Box,
    };
    return iconMap[iconName] || FileText;
  };

  // Check backend health on mount and load CSS
  useEffect(() => {
    checkBackendHealth();
    loadDiagnosticsCSS();

    return () => {
      // Cleanup CSS on unmount
      const existingLink = document.getElementById('diagnostics-styles');
      if (existingLink) {
        existingLink.remove();
      }
    };
    // Intentional mount-only health check + CSS injection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for inner sidebar visibility changes
  useEffect(() => {
    function handleInnerSidebarVisibilityChange(event) {
      setInnerSidebarVisible(event.detail.visible);
    }

    window.addEventListener('innerSidebarVisibilityChange', handleInnerSidebarVisibilityChange);
    return () => window.removeEventListener('innerSidebarVisibilityChange', handleInnerSidebarVisibilityChange);
  }, []);

  // Bridge the app's theme to the sandboxed diagnostics iframe. The frame has
  // an opaque origin and cannot see the parent's <html class="dark">, so we
  // watch it here and push changes in via postMessage (no iframe reload, so
  // sort/filter/scroll/chart state is preserved across a theme toggle).
  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => {
      const frame = iframeRef.current;
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage({ __diagnosticsTheme: true, ...appTheme() }, '*');
      }
    };
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-dark-variant', 'data-gradient', 'style'] });
    return () => observer.disconnect();
  }, []);

  // Tell the frame where the pane's viewport lies over it (see the frame-side
  // diagnosticsViewport in buildDiagnosticsSrcDoc): on every scroll of the
  // content pane, every resize, each height report and the frame's load, in
  // frame coordinates (the viewport's top relative to the frame's top, and its
  // height), one message per animation frame at most.
  const postViewport = useCallback(() => {
    if (viewportRaf.current) return;
    viewportRaf.current = requestAnimationFrame(() => {
      viewportRaf.current = 0;
      const frame = iframeRef.current;
      const scroller = contentScrollRef.current;
      if (!frame || !frame.contentWindow || !scroller) return;
      const fr = frame.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      frame.contentWindow.postMessage({ __diagnosticsViewport: true, top: Math.round(sr.top - fr.top), height: Math.round(sr.height) }, '*');
    });
  }, []);
  useEffect(() => {
    window.addEventListener('scroll', postViewport, true);
    window.addEventListener('resize', postViewport);
    return () => { window.removeEventListener('scroll', postViewport, true); window.removeEventListener('resize', postViewport); if (viewportRaf.current) cancelAnimationFrame(viewportRaf.current); };
  }, [postViewport]);

  // Size the iframe to its content height (reported via postMessage) so the
  // outer page scrolls as one flow, matching the previous inline rendering
  // instead of introducing a nested scrollbar.
  useEffect(() => {
    const handleMessage = (event) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (data && data.__diagnosticsIframe && data.type === 'height') {
        frame.style.height = `${data.height}px`;
        postViewport();
        // a cross-link's search term, handed to the page on its first height report (the page is up by then)
        if (pendingQueryRef.current) {
          const q = pendingQueryRef.current; pendingQueryRef.current = null;
          frame.contentWindow.postMessage({ __diagnosticsApi: true, dir: 'down', type: 'apply-query', query: q }, '*');
        }
      }
      // The frame's view of the theme it applied (computed card / divider /
      // chart colours) - a read-only hook for the live tests and the driver.
      if (data && data.__diagnosticsThemeApplied === true) {
        window.__diagnosticsFrameTheme = data;
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [postViewport]);

  // Authenticated-backend proxy for the sandboxed iframe. The frame has no
  // window.electronAPI (opaque origin) so it cannot attach the required
  // X-App-Token itself; instead it postMessages a request here and THIS trusted
  // context (which has apiFetch/getAppToken) performs the authenticated call -
  // but ONLY for paths on an explicit allowlist, so the channel can't be abused
  // to reach sensitive routes. Results are posted back to the frame by requestId.
  useEffect(() => {
    const activeStreams = new Map(); // requestId -> ReadableStreamDefaultReader
    const post = (msg) => {
      const frame = iframeRef.current;
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage({ __diagnosticsApi: true, dir: 'down', ...msg }, '*');
      }
    };
    const handleApiMessage = async (event) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const d = event.data;
      if (!d || d.__diagnosticsApi !== true || d.dir !== 'up') return;
      const { requestId, path, body, type } = d;

      if (type === 'open-tab') {
        // Navigation only: the target must be a tab the backend offered for
        // this report, so a fragment cannot request arbitrary parsers.
        let tab = typeof d.tab === 'string' ? d.tab : '';
        let subTab = typeof d.subTab === 'string' ? d.subTab : null;
        let known = (tabsRef.current || []).find(t => t.tab_name === tab);
        if (!known && !subTab) {
          // a sub-tab asked for by its own id (the Log Viewer, since it
          // moved under Log Collection): resolve it to its group
          const group = (tabsRef.current || []).find(t => (t.sub_tabs || []).some(st => st.tab_name === tab));
          if (group) { known = group; subTab = tab; tab = group.tab_name; }
        }
        if (!known) return;
        if (subTab && !(known.sub_tabs || []).some(st => st.tab_name === subTab)) return;
        setExpandedTabs(prev => (prev.includes(tab) ? prev : [...prev, tab]));
        pendingQueryRef.current = typeof d.query === 'string' && d.query ? d.query.slice(0, 200) : null;
        loadTabRef.current(tab, subTab);
        return;
      }
      if (type === 'scroll-to') {
        // A scroll of the content pane only: frame coordinate y to the top of the view
        const scroller = contentScrollRef.current;
        const y = Number(d.y);
        if (!scroller || !Number.isFinite(y)) return;
        const fr = frame.getBoundingClientRect();
        const sr = scroller.getBoundingClientRect();
        scroller.scrollTop = Math.max(0, scroller.scrollTop + (fr.top - sr.top) + y);
        return;
      }
      if (type === 'stream-abort') {
        const reader = activeStreams.get(requestId);
        if (reader) { activeStreams.delete(requestId); try { await reader.cancel(); } catch { /* already closed */ } }
        return;
      }
      if (type !== 'request' && type !== 'stream-request') return;

      const streaming = type === 'stream-request';
      const allowed = streaming
        ? DIAGNOSTICS_API_STREAM_ALLOWLIST.has(path)
        : DIAGNOSTICS_API_ALLOWLIST.has(path);
      if (!allowed) {
        // Refuse anything not explicitly allowlisted - this is the security boundary.
        post({ type: 'error', requestId, error: `Forbidden path: ${path}` });
        return;
      }

      try {
        const backendUrl = await getBackendUrl();
        const res = await apiFetch(`${backendUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        });

        if (!streaming) {
          let json = null;
          try { json = await res.json(); } catch { json = null; }
          post({ type: 'response', requestId, ok: res.ok, status: res.status, json });
          return;
        }

        // Streamed (SSE) response: read it here and forward decoded text chunks
        // so the frame can parse them incrementally exactly as it did before.
        if (!res.ok || !res.body) {
          post({ type: 'error', requestId, error: 'Failed to start streaming' });
          return;
        }
        const reader = res.body.getReader();
        activeStreams.set(requestId, reader);
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            post({ type: 'chunk', requestId, text: decoder.decode(value, { stream: true }) });
          }
          post({ type: 'end', requestId });
        } finally {
          activeStreams.delete(requestId);
        }
      } catch (err) {
        activeStreams.delete(requestId);
        post({ type: 'error', requestId, error: String((err && err.message) || err) });
      }
    };
    window.addEventListener('message', handleApiMessage);
    return () => window.removeEventListener('message', handleApiMessage);
  }, []);

  // Save reports directory to localStorage
  useEffect(() => {
    localStorage.setItem('diagnosticsReportsDirectory', reportsDirectory);
  }, [reportsDirectory]);

  // Load available reports when no tabs are loaded and backend is online
  useEffect(() => {
    if (tabs.length === 0 && backendStatus === 'online' && availableReports.length === 0 && !loadingReports) {
      loadAvailableReports(reportsDirectory);
    }
    // availableReports/loadingReports are only load-once guards, not triggers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.length, backendStatus, reportsDirectory]);

  // Reset banner dismissed state when backend status changes
  useEffect(() => {
    // Intentional reset tied to an external-status transition
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBackendBannerDismissed(false);
  }, [backendStatus]);

  // Restore active tab content on mount
  useEffect(() => {
    if (savedSession && savedSession.activeTab && tabs.length > 0 && !content) {
      loadTab(savedSession.activeTab, savedSession.activeSubTab);
    }
    // savedSession/content are restore-once guards; only tab arrival triggers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  // Save session to localStorage
  useEffect(() => {
    const session = {
      reportType,
      directory,
      tabs,
      expandedTabs,
      activeTab,
      activeSubTab,
      timestamp: Date.now()
    };
    localStorage.setItem('diagnostics-page-session', JSON.stringify(session));
  }, [reportType, directory, tabs, expandedTabs, activeTab, activeSubTab]);

  async function checkBackendHealth() {
    setCheckingBackend(true);
    try {
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000) // 3 second timeout
      });

      if (response.ok) {
        setBackendStatus('online');
        // Load available reports when backend comes online
        loadAvailableReports(reportsDirectory);
      } else {
        setBackendStatus('offline');
      }
    } catch {
      setBackendStatus('offline');
    } finally {
      setCheckingBackend(false);
    }
  }

  async function loadAvailableReports(directory = 'Downloads') {
    if (tabs.length > 0) return; // Don't load if already viewing a report

    setLoadingReports(true);
    try {
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/list_reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory }),
        signal: AbortSignal.timeout(5000)
      });

      if (response.ok) {
        const data = await response.json();
        setAvailableReports(data.reports || []);
      }
    } catch (err) {
      console.error('Failed to load available reports:', err);
      setAvailableReports([]);
    } finally {
      setLoadingReports(false);
    }
  }

  async function loadReportDirectory(reportPath, reportType) {
    // Clear all existing state before loading new report
    setActiveTab(null);
    setActiveSubTab(null);
    setContent('');
    setTabs([]);
    setExpandedTabs([]);
    setError('');

    // Set new report details
    setDirectory(reportPath);
    setReportType(reportType);
    setLoadingTabs(true);

    try {
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/get_tabs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report_type: reportType, directory: reportPath })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Backend service not responding' }));
        throw new Error(errorData.error || 'Failed to load tabs');
      }

      const data = await response.json();
      setTabs(data.tabs);

      // Expand and load first tab (System) by default
      if (data.tabs.length > 0) {
        const firstTab = data.tabs[0].tab_name;
        setExpandedTabs([firstTab]);

        // Automatically load the first tab's content with explicit report type and directory
        setLoadingTabs(false);
        await loadTab(firstTab, null, reportType, reportPath);
        return;
      }
    } catch (err) {
      if (err.message.includes('fetch') || err.message.includes('NetworkError')) {
        setError('');
        setBackendStatus('offline');
      } else {
        setError(err.message);
      }
      setTabs([]);
    } finally {
      setLoadingTabs(false);
    }
  }

  async function loadDiagnosticsCSS() {
    // Check if CSS is already loaded
    if (document.getElementById('diagnostics-styles')) {
      return;
    }

    try {
      // Load CSS from Flask backend
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/static/styles.css`);
      if (response.ok) {
        const cssText = await response.text();

        // Create style element and inject CSS
        const styleElement = document.createElement('style');
        styleElement.id = 'diagnostics-styles';
        styleElement.textContent = cssText;
        document.head.appendChild(styleElement);
      }
    } catch (err) {
      console.warn('Failed to load diagnostics CSS:', err);
    }
  }

  tabsRef.current = tabs;

  async function loadTab(tabName, subTabName = null, overrideReportType = null, overrideDirectory = null) {
    setActiveTab(tabName);
    setActiveSubTab(subTabName);
    setLoading(true);
    setContent('<div class="flex items-center justify-center py-10"><div class="animate-spin rounded-full h-8 w-8 border-b-2 border-os-blue"></div></div>');

    try {
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/load_tab`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_type: overrideReportType || reportType,
          directory: overrideDirectory || directory,
          tab: tabName,
          sub_tab: subTabName
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Backend service not responding' }));
        throw new Error(errorData.error || 'Failed to load content');
      }

      const data = await response.json();
      // The fragment is rendered inside a sandboxed iframe (see
      // buildDiagnosticsSrcDoc); its <script> tags execute natively in the
      // frame's opaque origin, so no manual extraction/execution is needed
      // (and none of it runs with renderer/electronAPI privileges anymore).
      setContent(data.html);

    } catch (err) {
      if (err.message.includes('fetch') || err.message.includes('NetworkError')) {
        setContent('');
        setBackendStatus('offline');
      } else {
        setContent('');
      }
    } finally {
      setLoading(false);
    }
  }
  loadTabRef.current = loadTab;

  function toggleTab(tabName) {
    setExpandedTabs(prev =>
      prev.includes(tabName)
        ? prev.filter(t => t !== tabName)
        : [...prev, tabName]
    );
  }

  function handleTabClick(tab) {
    // Always load the tab content (including category overview pages)
    loadTab(tab.tab_name);
  }

  function handleReset() {
    setTabs([]);
    setActiveTab(null);
    setActiveSubTab(null);
    setContent('');
    setError('');
    // Clear session from localStorage
    localStorage.removeItem('diagnostics-page-session');
    // Reload available reports
    if (backendStatus === 'online') {
      loadAvailableReports(reportsDirectory);
    }
  }

  function handleBrowseDifferentLocation() {
    setShowBrowseDirectory(true);
  }

  function handleConfirmDirectory(newDirectory) {
    setReportsDirectory(newDirectory);
    setShowBrowseDirectory(false);
    loadAvailableReports(newDirectory);
  }

  // Build the sandboxed iframe document from the (untrusted) tab fragment.
  // Depends only on `content`: theme changes are pushed into the live frame via
  // postMessage rather than rebuilding srcDoc, so toggling the theme doesn't
  // reload the frame or reset its interactive state.
  const iframeSrcDoc = useMemo(() => {
    if (!content) return '';
    // Read the live theme at bake time so first paint matches the app even on a
    // reload/session-restore where ThemeContext applies the class after render.
    // Theme changes AFTER bake are handled via postMessage (see below), not by
    // rebuilding the document, so this depends only on `content`.
    return buildDiagnosticsSrcDoc(content, appTheme());
  }, [content]);

  // The tab-loading pill: the same "Loading <tab>… 2.1 s" pill the plugins show for their own work (diagBusy), here in the
  // parent while the tab's page is parsed and rendered on the backend, after 300 ms so a quick tab shows none
  // (the start time lives in a ref and the 100 ms interval is the only thing that sets state, so the effect itself renders nothing)
  const loadingSinceRef = useRef(0);
  const [loadingNow, setLoadingNow] = useState(0);
  useEffect(() => {
    if (!loading) { loadingSinceRef.current = 0; return undefined; }
    loadingSinceRef.current = Date.now();
    const t = setInterval(() => setLoadingNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [loading]);
  const loadingLabel = activeSubTab
    ? tabs.find(t => t.tab_name === activeTab)?.sub_tabs?.find(st => st.tab_name === activeSubTab)?.label
    : tabs.find(t => t.tab_name === activeTab)?.label;
  const loadingElapsed = loading && loadingSinceRef.current ? loadingNow - loadingSinceRef.current : 0;
  const loadingPill = loadingElapsed >= 300 ? (
    <div className="ui-busy-pill ui-busy" role="status" data-testid="diagnostics-loading-pill">
      <span className="ui-busy-pill-text">Loading {loadingLabel || 'the tab'}… {(loadingElapsed / 1000).toFixed(1)} s</span>
    </div>
  ) : null;

  // Memoize the content rendering to prevent re-renders when sidebar visibility changes
  const renderedContent = useMemo(() => {
    if (loading) {
      return <LoadingGame message="Parsing diagnostic data..." />;
    }
    if (!content) {
      return null;
    }
    return (
      <iframe
        key={`${directory}-${activeTab}-${activeSubTab || 'main'}`}
        ref={iframeRef}
        title="Diagnostics content"
        data-tab={activeSubTab || activeTab}
        sandbox="allow-scripts"
        srcDoc={iframeSrcDoc}
        onLoad={() => {
          // Re-assert the current theme once the frame is live, in case its
          // listener wasn't ready when the theme-bridge effect last fired.
          const frame = iframeRef.current;
          if (frame && frame.contentWindow) {
            frame.contentWindow.postMessage(
              { __diagnosticsTheme: true, ...appTheme() },
              '*'
            );
          }
          postViewport();
        }}
        style={{ width: '100%', minHeight: '120px', border: 'none', display: 'block' }}
      />
    );
  }, [loading, content, iframeSrcDoc, activeTab, activeSubTab, directory, postViewport]);

  return (
    <div className="flex h-full">
      {/* Parser Tabs Sidebar */}
      {(innerSidebarVisible || isMobile) && (
      <ResizableSidebar
        defaultWidth={288}
        minWidth={200}
        maxWidth={500}
        storageKey="diagnosticsPage-sidebar-width"
        position="right"
        className="bg-os-card flex flex-col"
      >
      {(width) => (
        <DiagnosticsSidebar
          tabs={tabs}
          expandedTabs={expandedTabs}
          activeTab={activeTab}
          activeSubTab={activeSubTab}
          loadingTabs={loadingTabs}
          backendStatus={backendStatus}
          directory={directory}
          onToggleTab={toggleTab}
          onTabClick={handleTabClick}
          onSubTabClick={loadTab}
          onReset={handleReset}
          getIconComponent={getIconComponent}
          width={width}
        />
      )}
      </ResizableSidebar>
      )}

      {/* Main Content Area */}
      <div className={`flex-1 bg-os-card overflow-auto flex flex-col ${isMobile ? 'min-w-0' : ''}`}>
        {isMobile && <MobilePageHeader title="Diagnostics" />}
        {/* Report load error (the folder browser is the only way in) */}
        {error && (
          <div className="bg-red-50 px-6 py-3" data-testid="diagnostics-load-error">
            <div className="flex items-start gap-3">
              <AlertCircle size={20} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-red-800 dark:text-red-200">Could not load the report</p>
                <p className="text-xs text-red-700 dark:text-red-300 mt-1">{error}</p>
              </div>
              <button
                onClick={() => setError('')}
                className="btn btn-danger-ghost px-3 py-1.5 text-xs"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {/* Backend Status Warning */}
        {backendStatus === 'offline' && !backendBannerDismissed && (
          <div className="bg-red-50 px-6 py-3">
            <div className="flex items-start gap-3">
              <AlertCircle size={20} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-red-800 dark:text-red-200">Backend Service Not Running</p>
                <p className="text-xs text-red-700 dark:text-red-300 mt-1">
                  The Flask backend is not responding. Start it with:
                </p>
                <code className="block mt-2 text-xs bg-red-100 text-red-900 dark:text-red-200 px-3 py-2 rounded-sm font-mono">
                  cd backend && source venv/bin/activate && python app.py
                </code>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    setBackendStatus('checking');
                    checkBackendHealth();
                  }}
                  disabled={checkingBackend}
                  className="btn btn-danger-ghost flex items-center gap-2 px-3 py-1.5 text-xs"
                >
                  Retry
                </button>
                <button
                  onClick={() => setBackendBannerDismissed(true)}
                  className="btn btn-danger-ghost p-1"
                >
                  <X size={16} className="text-red-600 dark:text-red-400" />
                </button>
              </div>
            </div>
          </div>
        )}

        {tabs.length > 0 && activeTab ? (
          <>
            {/* Breadcrumbs - Commented out, can be restored later */}
            {/* <div className="bg-os-card border-b border-os-border px-6 pt-6 pb-px">
              <Breadcrumbs currentPage="diagnostics" onNavigate={onNavigate} />
            </div> */}

            {/* Content */}
            <div className="flex-1 overflow-auto" ref={contentScrollRef}>
              <div className="p-6">
                <h1 className="text-xl font-semibold text-os-text-primary mb-4">
                  {activeSubTab
                    ? tabs.find(t => t.tab_name === activeTab)?.sub_tabs.find(st => st.tab_name === activeSubTab)?.label
                    : tabs.find(t => t.tab_name === activeTab)?.label}
                </h1>

                {renderedContent}
                {loadingPill}
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Breadcrumbs - Commented out, can be restored later */}
            {/* <div className="bg-os-card border-b border-os-border px-6 pt-6 pb-px">
              <Breadcrumbs currentPage="diagnostics" onNavigate={onNavigate} />
            </div> */}

            {/* Empty State / Available Reports */}
            <div className="flex-1 overflow-auto flex items-center justify-center">
              <div className="max-w-5xl w-full px-6 py-8">
                {/* Available Reports */}
                {loadingReports ? (
                  <div className="text-center py-8">
                    <Loader size={32} className="animate-spin text-os-blue mx-auto mb-2" />
                    <p className="text-sm text-os-text-secondary">Scanning {reportsDirectory} folder...</p>
                  </div>
                ) : availableReports.length > 0 ? (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-os-text-primary flex items-center gap-2">
                        Available Reports in {reportsDirectory} ({availableReports.length})
                      </h3>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => loadAvailableReports(reportsDirectory)}
                          disabled={loadingReports}
                          className="btn btn-secondary flex items-center gap-1.5 px-2.5 py-1.5 text-xs"
                          title="Refresh report list"
                        >
                          Refresh
                        </button>
                        <button
                          onClick={handleBrowseDifferentLocation}
                          disabled={backendStatus === 'offline'}
                          className="btn btn-primary flex items-center gap-1.5 px-2.5 py-1.5 text-xs"
                          title={backendStatus === 'offline' ? 'Backend service is not running' : 'Browse for report directory'}
                        >
                          Browse different location
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {availableReports.map((report, index) => (
                        <button
                          key={index}
                          onClick={() => loadReportDirectory(report.path, report.type)}
                          className="btn btn-secondary justify-start flex items-start gap-3 p-4 text-left group"
                        >
                          <div className="shrink-0 mt-0.5">
                            {report.type === 'sosreport' ? (
                              <Server size={20} className="text-os-text-secondary group-hover:text-os-blue transition-colors" />
                            ) : (
                              <Layers size={20} className="text-os-text-secondary group-hover:text-os-blue transition-colors" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-sm font-medium text-os-text-primary truncate">
                                {report.name}
                              </span>
                              <span className={`text-xs px-2 py-0.5 rounded shrink-0 ${
 report.type ==='sosreport'
 ?'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-200'
 :'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-200'
 }`}>
                                {report.type}
                              </span>
                            </div>
                            <div className="text-xs text-os-text-muted">
                              Modified: {new Date(report.modified * 1000).toLocaleDateString()}
                            </div>
                          </div>
                          <ChevronRight size={16} className="shrink-0 text-os-text-muted group-hover:text-os-blue transition-colors mt-1" />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : backendStatus === 'online' ? (
                  <div className="text-center py-8 px-4">
                    <FolderOpen size={40} className="text-os-text-muted mx-auto mb-3 opacity-50" />
                    <p className="text-sm text-os-text-secondary mb-2">
                      No reports found in {reportsDirectory} folder
                    </p>
                    <p className="text-xs text-os-text-muted mb-4">
                      Looking for directories named: sosreport*, must-gather*, or inspect*
                    </p>
                    <div className="flex items-center gap-2 justify-center">
                      <button
                        onClick={() => loadAvailableReports(reportsDirectory)}
                        disabled={loadingReports}
                        className="btn btn-secondary inline-flex items-center gap-2 px-3 py-2 text-sm"
                      >
                        Refresh
                      </button>
                      <button
                        onClick={handleBrowseDifferentLocation}
                        disabled={backendStatus === 'offline'}
                        className="btn btn-primary inline-flex items-center gap-2 px-3 py-2 text-sm"
                        title={backendStatus === 'offline' ? 'Backend service is not running' : 'Browse for report directory'}
                      >
                        Browse different location
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Browse Directory Modal */}
      <BrowseDirectoryModal
        isOpen={showBrowseDirectory}
        currentDirectory={reportsDirectory}
        onConfirm={handleConfirmDirectory}
        onCancel={() => setShowBrowseDirectory(false)}
      />
    </div>
  );
}
