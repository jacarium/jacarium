/* global Chart */
/*
  The shared Diagnostics frame script: the busy state (window.diagBusy) and
  the chart helper (window.diagChart) every plugin uses, so a search, a
  filter, a "Load more" and a chart look and behave the same on every tab.

  DiagnosticsPage (src/components/DiagnosticsPage.jsx, buildDiagnosticsSrcDoc)
  inlines this file into every tab's frame right after Chart.js and the
  theme bridge; the standalone Flask dashboard links it. Plain script, no
  bundler: it runs inside the sandboxed frame. The styles are the ui-*
  rules of backend/static/styles.css. tests/diagnostics-ui-consistency
  .test.mjs guards both.

  diagBusy
    var h = diagBusy.start(trigger, { label, table, bar, cancel, live });
      trigger: the control the user pressed (a sort header's marker becomes
               a spinner; a text button reads "Loading…" with a spinner and
               is disabled; a select's label gets the spinner) or null;
      label:   'Searching…' | 'Loading…' | 'Filtering…' (the pill and the
               live region; default 'Loading…');
      table:   the element(s) to dim (aria-busy, pointer-events none), the
               old rows stay until the new ones arrive;
      bar:     the element that carries the thin progress bar along its top
               (a sticky header, a toolbar; default: the first table's
               thead or the table itself);
      cancel:  a function - the pill then offers Cancel;
      scroll:  an element to keep at the top of the view when done (a
               sticky header after a sort).
    h.done(summary)        clears everything, announces the summary
    h.fail(message, retry) clears the busy state, shows the message in the
                           pill with Retry (and a dismiss)
    h.cancel()             clears everything (the caller's cancel ran)
    h.update(text)         changes the pill's text
    diagBusy.run(trigger, opts, work)   a client-side filter / sort: the
      busy state shows, the browser paints, work() runs, done; the pill
      only appears when the work takes longer than 300 ms
    diagBusy.wrap(trigger, opts, fn)    fn returns a promise (a server call)
    The pill sits at the bottom of the pane (--frame-view-bottom from the
    bridge) after 300 ms, so a fast answer shows no pill; reduced motion
    gets still spinners and a still bar (CSS).

  diagChart
    diagChart.make(canvasOrId, { type, data, options, plugins })
      a Chart.js chart with the shared defaults merged in: the theme's text
      and grid colours, the legend (small square swatches, uppercase
      labels), the tooltip, animation off under reduced motion, category
      axes that show every label, lines with no tension that do not cross a
      gap, bars with a small radius and a capped thickness, series colours
      from the one palette (ok blue, errors red, warnings amber, other grey,
      then the categorical series in order) unless a dataset keeps its own,
      the empty state ("No data for this filter") and a minimum height.
    diagChart.timeSeries(canvas, { buckets, step, series, onBucket, stacked })
      a bar/line chart over time buckets (from the backend's bucket plan:
      {t, label, n, ...} items and {gap: true} items between capture
      windows) on the broken axis; series: [{ label, role, value(bucket) }]
    diagChart.categoryBars(canvas, rows, { colour, onRow, stacked })
      horizontal bars, one per row ({name, count, errors?}), every label
    diagChart.retheme()   re-resolves every helper chart's colours (the
      bridge calls it on a theme switch: no black fills)
    diagChart.fmt        num (1.2k), bytes (KiB/MiB), ms (ms/s), pct
    diagChart.palette()  the current palette
*/
(function () {
  'use strict';
  var doc = document;
  var reduced = function () { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  var el = function (tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; };
  var token = function (name, fallback) { var v = ''; try { v = getComputedStyle(doc.documentElement).getPropertyValue(name); } catch { /* no style */ } v = (v || '').trim(); return v || fallback; };
  var themeColor = function (role, fallback) { return typeof window.diagnosticsThemeColor === 'function' ? window.diagnosticsThemeColor(role) : fallback; };

  /* ------------------------------------------------------------------ */
  /* diagBusy                                                            */
  /* ------------------------------------------------------------------ */
  var PILL_DELAY = 300;
  var pill = null, pillText = null, pillCancel = null, pillRetry = null, pillClose = null, live = null;
  function ensurePill() {
    if (pill) return;
    pill = el('div', 'ui-busy-pill'); pill.id = 'ui-busy-pill'; pill.setAttribute('role', 'status'); pill.hidden = true;
    pillText = el('span', 'ui-busy-pill-text'); pillText.id = 'ui-busy-pill-text';
    pillCancel = el('button', 'btn btn-secondary btn-sm', 'Cancel'); pillCancel.type = 'button'; pillCancel.id = 'ui-busy-cancel';
    pillRetry = el('button', 'btn btn-secondary btn-sm', 'Retry'); pillRetry.type = 'button'; pillRetry.id = 'ui-busy-retry'; pillRetry.hidden = true;
    pillClose = el('button', 'btn btn-ghost btn-sm ui-busy-pill-close', '×'); pillClose.type = 'button'; pillClose.id = 'ui-busy-close'; pillClose.setAttribute('aria-label', 'Dismiss'); pillClose.title = 'Dismiss'; pillClose.hidden = true;
    pill.appendChild(pillText); pill.appendChild(pillCancel); pill.appendChild(pillRetry); pill.appendChild(pillClose);
    live = el('div', 'ui-sr'); live.id = 'ui-busy-live'; live.setAttribute('aria-live', 'polite');
    doc.body.appendChild(pill); doc.body.appendChild(live);
    pillClose.addEventListener('click', hidePill);
  }
  function showPill(mode, text) {
    ensurePill();
    pill.hidden = false;
    pill.classList.toggle('ui-busy', mode === 'busy'); pill.classList.toggle('ui-error', mode === 'error');
    pillText.textContent = text;
    pillCancel.hidden = mode !== 'busy' || !pillCancel.$fn;
    pillRetry.hidden = mode !== 'error' || !pillRetry.$fn;
    pillClose.hidden = mode !== 'error';
  }
  function hidePill() { if (!pill) return; pill.hidden = true; pill.classList.remove('ui-busy', 'ui-error'); }
  var current = null;   // one busy state at a time per page: a newer start() replaces the older
  function toList(x) { if (!x) return []; if (x.length !== undefined && !x.tagName) return Array.prototype.slice.call(x); return [x]; }
  function isButton(t) { return t && t.tagName && (t.tagName === 'BUTTON' || t.tagName === 'A' || t.getAttribute('role') === 'button'); }
  function start(trigger, opts) {
    opts = opts || {};
    ensurePill();
    if (current) current.$clear();
    var label = opts.label || 'Loading…';
    var tables = toList(opts.table);
    var bar = opts.bar || (tables[0] ? (tables[0].querySelector('thead') || tables[0]) : null);
    var startedAt = (window.performance && performance.now) ? performance.now() : Date.now();
    var elapsed = function () { var now = (window.performance && performance.now) ? performance.now() : Date.now(); return ((now - startedAt) / 1000).toFixed(1) + ' s'; };
    var timer = null, tick = null, textOnly = false;
    // the trigger: a sort header's button keeps its label and gets a spinner for its marker; a text button says Loading…; a select's label a spinner
    if (trigger && trigger.classList) {
      trigger.classList.add('ui-loading');
      if (isButton(trigger) && !trigger.classList.contains('lc-sort') && !trigger.classList.contains('ui-icon-btn') && trigger.textContent.trim()) {
        textOnly = true;
        if (!trigger.dataset.uiLabel) trigger.dataset.uiLabel = trigger.textContent;
        trigger.textContent = 'Loading…';   // the button itself stays short; the pill and the live region carry the label
        trigger.disabled = true;
      }
    }
    tables.forEach(function (t) { t.setAttribute('aria-busy', 'true'); t.classList.add('ui-busy-table'); });
    if (bar) { bar.classList.add('ui-progress'); }
    live.textContent = label.replace(/…$/, '');
    pillCancel.$fn = opts.cancel || null;
    pillCancel.onclick = function () { if (pillCancel.$fn) { var fn = pillCancel.$fn; handle.cancel(); fn(); } };
    hidePill();
    timer = setTimeout(function () { showPill('busy', label + ' ' + elapsed()); tick = setInterval(function () { pillText.textContent = label + ' ' + elapsed(); }, 100); }, opts.pillDelay === undefined ? PILL_DELAY : opts.pillDelay);
    var handle = {
      $clear: function () {
        clearTimeout(timer); clearInterval(tick); timer = tick = null;
        if (trigger && trigger.classList) {
          trigger.classList.remove('ui-loading');
          if (textOnly) { trigger.textContent = trigger.dataset.uiLabel || trigger.textContent; trigger.disabled = false; }
        }
        tables.forEach(function (t) { t.setAttribute('aria-busy', 'false'); t.classList.remove('ui-busy-table'); });
        if (bar) bar.classList.remove('ui-progress');
        if (current === handle) current = null;
      },
      update: function (text) { label = text; if (pill && !pill.hidden && pill.classList.contains('ui-busy')) pillText.textContent = label + ' ' + elapsed(); },
      done: function (summary) {
        handle.$clear();
        if (pill && pill.classList.contains('ui-busy')) hidePill();
        if (summary) live.textContent = summary;
        if (opts.scroll && window.diagnosticsViewport && window.diagnosticsScrollTo) {
          var top = opts.scroll.getBoundingClientRect().top;
          if (window.diagnosticsViewport.top > top) window.diagnosticsScrollTo(Math.round(top));
        }
      },
      fail: function (message, retry) {
        handle.$clear();
        live.textContent = message;
        pillRetry.$fn = retry || null;
        pillRetry.onclick = function () { hidePill(); if (pillRetry.$fn) pillRetry.$fn(); };
        showPill('error', message);
      },
      cancel: function () { handle.$clear(); hidePill(); live.textContent = 'Cancelled'; },
      elapsed: elapsed,
    };
    current = handle;
    return handle;
  }
  // a client-side filter / sort: the busy state shows, the browser paints a frame, the work runs, done
  function run(trigger, opts, work) {
    var h = start(trigger, opts);
    return new Promise(function (resolve, reject) {
      requestAnimationFrame(function () { setTimeout(function () {
        var out;
        try { out = work(); } catch (e) { h.fail((opts && opts.errorLabel ? opts.errorLabel + ': ' : 'Failed: ') + (e && e.message || e), function () { run(trigger, opts, work); }); reject(e); return; }
        Promise.resolve(out).then(function (v) { h.done(opts && opts.summary ? (typeof opts.summary === 'function' ? opts.summary(v) : opts.summary) : ''); resolve(v); }, function (e) { h.fail((opts && opts.errorLabel ? opts.errorLabel + ': ' : 'Failed: ') + (e && e.message || e), function () { run(trigger, opts, work); }); reject(e); });
      }, 0); });
    });
  }
  function wrap(trigger, opts, fn) { return run(trigger, opts, fn); }
  // a template's inline filter handler (oninput / onchange on a field or select): the nearest table dims under the bar while the
  // filter runs; a button is the trigger, a field is not (it keeps the focus and has no marker to replace)
  function filter(control, work, opts) {
    var scope = control && control.closest ? (control.closest('.panel') || control.closest('#diagnostics-content') || doc) : doc;
    var table = scope.querySelector('table.ui-table, table');
    var o = merge({ label: 'Filtering\u2026', table: table, bar: table && (table.querySelector('thead') || table) }, opts || {});
    return run(isButton(control) ? control : null, o, work);
  }
  window.diagBusy = { start: start, run: run, wrap: wrap, filter: filter, hidePill: hidePill, PILL_DELAY: PILL_DELAY, get current() { return current; } };

  /* ------------------------------------------------------------------ */
  /* diagTables: every table scrolls sideways when wide (a wrapper) and   */
  /* stacks under 640px with its header text in front of each cell       */
  /* ------------------------------------------------------------------ */
  function labelCells(table) {
    var heads = Array.prototype.slice.call(table.querySelectorAll('thead th')).map(function (th) { return th.textContent.replace(/\s+/g, ' ').trim(); });
    if (!heads.length) return;
    Array.prototype.slice.call(table.querySelectorAll('tbody tr')).forEach(function (tr) {
      Array.prototype.slice.call(tr.children).forEach(function (td, i) { if (td.tagName === 'TD' && !td.hasAttribute('data-label') && heads[i]) td.setAttribute('data-label', heads[i]); });
    });
  }
  function wrapTable(table) {
    var legacy = table.parentElement && table.parentElement.classList.contains('overflow-x-auto') ? table.parentElement : null;
    if (legacy && !legacy.classList.contains('ui-table-wrap') && legacy.children.length === 1) legacy.classList.add('ui-table-wrap');   // the older wrapper becomes the table box
    if (table.closest('.ui-table-wrap, .lc-table-wrap, .au-table-wrap, .kd-table-wrap, .bl-table-wrap')) return;
    // a legacy wrapper with other children: the table gets its own box inside it
    var w = el('div', 'ui-table-wrap');
    table.parentNode.insertBefore(w, table);
    w.appendChild(table);
  }
  function setupTables(root) {
    var tables = Array.prototype.slice.call((root || doc).querySelectorAll('table'));
    tables.forEach(function (t) { if (t.closest('.au-diff, .lc-table-wrap') || t.classList.contains('lc-table') || t.classList.contains('au-diff')) return; if (!t.classList.contains('ui-table')) t.classList.add('ui-table'); wrapTable(t); labelCells(t); });
    setupXrows(root); defaultSort(root);
  }
  var pendingLabel = null;
  function watchTables() {
    if (!window.MutationObserver) return;
    var mo = new MutationObserver(function () {
      if (pendingLabel) return;
      pendingLabel = setTimeout(function () { pendingLabel = null; setupTables(); }, 50);
    });
    mo.observe(doc.body, { childList: true, subtree: true });
  }
  /* the sort marker of a column: aria-sort on the header cell (the frame stylesheet draws the triangle and the
     primary colour; a cell with the shared .lc-sort button gets the button's classes), every other cell cleared */
  function markSort(target, ascending) {
    var th = target && target.closest ? target.closest('th, [role="columnheader"]') : null;
    if (!th) return;
    Array.prototype.forEach.call(th.parentNode.querySelectorAll('[aria-sort]'), function (o) { o.removeAttribute('aria-sort'); var ob = o.querySelector('.lc-sort'); if (ob) ob.classList.remove('lc-sorted', 'lc-asc'); });
    th.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
    var b = th.querySelector('.lc-sort');
    if (b) { b.classList.add('lc-sorted'); b.classList.toggle('lc-asc', !!ascending); }
  }
  // a table the parser pre-sorted says so on the header cell (data-sorted="descending"): the marker on load
  function defaultSort(root) {
    Array.prototype.forEach.call((root || doc).querySelectorAll('thead tr'), function (row) {
      if (row.querySelector('[aria-sort]')) return;
      var th = row.querySelector('th[data-sorted]');
      if (th) markSort(th, th.getAttribute('data-sorted') === 'ascending');
    });
  }

  /* ---- expandable rows: tr.ui-xrow (the chevron cell is added when missing) followed by tr.ui-xrow-panel ---- */
  var CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  function xrowButton() { var b = el('button', 'ui-xrow-btn'); b.type = 'button'; b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-label', 'Details'); b.innerHTML = CHEVRON; return b; }
  function xrowCell() { var td = el('td', 'ui-xrow-cell'); td.setAttribute('data-label', ''); td.appendChild(xrowButton()); return td; }
  function xrowPanel(cols, body) {
    var tr = el('tr', 'ui-xrow-panel'); tr.hidden = true;
    var td = el('td'); td.colSpan = cols; td.setAttribute('data-label', '');
    var box = el('div', 'ui-xrow-body'); if (body) box.appendChild(body);
    td.appendChild(box); tr.appendChild(td);
    return tr;
  }
  function panelOf(row) { var n = row.nextElementSibling; return n && n.classList.contains('ui-xrow-panel') ? n : null; }
  function setOpen(row, open) {
    var p = panelOf(row);
    if (!p) return;
    if (open === undefined) open = p.hidden;
    p.hidden = !open;
    row.classList.toggle('ui-open', open);
    row.setAttribute('aria-expanded', open ? 'true' : 'false');
    var b = row.querySelector('.ui-xrow-btn'); if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
    try { window.dispatchEvent(new Event('resize')); } catch { /* an old frame */ }
  }
  function setupXrows(root) {
    Array.prototype.forEach.call((root || doc).querySelectorAll('tr.ui-xrow'), function (row) {
      if (row.$xrow) return;
      row.$xrow = true;
      if (!row.querySelector('.ui-xrow-cell')) row.insertBefore(xrowCell(), row.firstChild);
      if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex', '0');
      if (!row.hasAttribute('aria-expanded')) row.setAttribute('aria-expanded', 'false');
      var p = panelOf(row); if (p && !p.hidden && !row.classList.contains('ui-open')) p.hidden = true;
    });
    Array.prototype.forEach.call((root || doc).querySelectorAll('table'), function (t) {
      if (t.$xrowHead || !t.querySelector('tr.ui-xrow')) return;
      t.$xrowHead = true;
      var hr = t.querySelector('thead tr');
      if (hr && !hr.querySelector('.ui-xrow-th')) { var th = el('th', 'ui-xrow-th'); th.setAttribute('aria-label', 'Details'); hr.insertBefore(th, hr.firstChild); }
    });
  }
  function visibleRows(table) { return Array.prototype.filter.call(table.querySelectorAll('tr.ui-xrow'), function (r) { return !r.hidden && r.style.display !== 'none'; }); }
  doc.addEventListener('click', function (e) {
    var t = e.target;
    var all = t.closest ? t.closest('[data-xrow-all]') : null;
    if (all) {
      var table = doc.querySelector(all.getAttribute('data-table') || '') || all.closest('.panel, .ui-card, section, body').querySelector('table');
      if (table) visibleRows(table).forEach(function (r) { setOpen(r, all.getAttribute('data-xrow-all') === 'open'); });
      return;
    }
    var copy = t.closest ? t.closest('[data-copy]') : null;
    if (copy) {
      e.stopPropagation();
      var text = copy.getAttribute('data-copy'); if (!text) { var src = copy.previousElementSibling; text = src ? src.textContent : ''; }
      try { navigator.clipboard.writeText(text); } catch { /* no clipboard in this frame */ }
      var was = copy.textContent; copy.textContent = 'Copied'; copy.classList.add('ui-copied');
      setTimeout(function () { copy.textContent = was; copy.classList.remove('ui-copied'); }, 1200);
      return;
    }
    var row = t.closest ? t.closest('tr.ui-xrow') : null;
    if (!row) return;
    if (t.closest('a, input, select, textarea, label, details, button:not(.ui-xrow-btn)')) return;
    setOpen(row);
  });
  doc.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var t = e.target;
    if (!t.classList || !t.classList.contains('ui-xrow')) return;
    e.preventDefault();
    setOpen(t);
  });
  window.diagTables = { setup: setupTables, label: labelCells, wrap: wrapTable, markSort: markSort, defaultSort: defaultSort, xrows: setupXrows, open: setOpen, xrowCell: xrowCell, xrowPanel: xrowPanel };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { setupTables(); watchTables(); });
  else { setupTables(); watchTables(); }

  /* ------------------------------------------------------------------ */
  /* diagChart                                                           */
  /* ------------------------------------------------------------------ */
  var probe = null;
  var norm = function (c) { if (!probe) probe = doc.createElement('canvas').getContext('2d'); probe.fillStyle = '#000000'; probe.fillStyle = String(c || '').trim(); return probe.fillStyle; };
  var rgba = function (c, a) {
    var n = norm(c);
    if (n[0] === '#') return 'rgba(' + parseInt(n.slice(1, 3), 16) + ', ' + parseInt(n.slice(3, 5), 16) + ', ' + parseInt(n.slice(5, 7), 16) + ', ' + a + ')';
    var m = /rgba?\(([^)]+)\)/.exec(n);
    if (m) { var p = m[1].split(',').map(parseFloat); return 'rgba(' + p[0] + ', ' + p[1] + ', ' + p[2] + ', ' + a + ')'; }
    return n;
  };
  var accent = function () { return norm(token('--os-blue', '#0066cc')); };
  var text = function () { return norm(themeColor('text', '#333333')); };
  var muted = function () { return norm(themeColor('muted', '#6a6e73')); };
  var grid = function () { return norm(themeColor('grid', '#dddddd')); };
  var mono = function () { return token('--font-mono', 'monospace'); };
  var sans = function () { return token('--font-sans', '') || 'inherit'; };
  // the one palette: fixed meanings, then the categorical series in order (the Log Collection section hues)
  var SERIES_FALLBACK = ['#2563eb', '#7c3aed', '#0d9488', '#d97706', '#db2777', '#16a34a', '#ea580c', '#64748b'];
  // the categorical series: the --chart-cat-N tokens of the theme (src/index.css), so a chart's segment, its legend
  // swatch, a section dot and a chip share one colour per category
  function series() { return SERIES_FALLBACK.map(function (fb, i) { return norm(token('--chart-cat-' + (i + 1), fb)); }); }
  function palette() {
    var sr = series();
    // the roles: the theme's --chart-<role> tokens (src/index.css), the badge / accent hues the strip and the
    // meters use, so a warn bar is the WARN badge's amber in both themes
    var role = function (name, fb) { return norm(token('--chart-' + name, fb)); };
    var p = { ok: role('ok', accent()), good: role('good', '#16a34a'), error: role('bad', '#dc2626'), bad: role('bad', '#dc2626'), warn: role('warn', '#d97706'), other: role('muted', '#9ca3af'), neutral: role('muted', '#9ca3af'), muted: role('muted', '#9ca3af'), info: role('info', accent()), series: sr };
    sr.forEach(function (c, i) { p['cat' + (i + 1)] = c; });   // the categorical colours by name (cat1..cat8), for a state that is neither good nor bad
    return p;
  }
  function roleColor(role, i) { var p = palette(); if (role && p[role]) return p[role]; return p.series[(i || 0) % p.series.length]; }
  var registry = [];
  var BREAK_PX = 28;
  var fmt = {
    num: function (n) { n = Number(n || 0); if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'G'; if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'; if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'; return n.toLocaleString('en-US'); },
    bytes: function (b) { b = Number(b || 0); var u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; var i = 0; while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; } return (i ? b.toFixed(1).replace(/\.0$/, '') : b) + ' ' + u[i]; },
    ms: function (ms) { ms = Number(ms || 0); if (ms < 1000) return Math.round(ms) + ' ms'; if (ms < 60000) return (ms / 1000).toFixed(1).replace(/\.0$/, '') + ' s'; if (ms < 3600000) return (ms / 60000).toFixed(1).replace(/\.0$/, '') + ' min'; return (ms / 3600000).toFixed(1).replace(/\.0$/, '') + ' h'; },
    seconds: function (s) { return fmt.ms(Number(s || 0) * 1000); },
    pct: function (v) { return (Math.round(Number(v || 0) * 10) / 10) + '%'; },
    step: function (seconds) { return seconds < 60 ? seconds + ' s' : seconds < 3600 ? (seconds / 60) + ' min' : seconds < 86400 ? (seconds / 3600) + ' h' : (seconds / 86400) + ' d'; },
  };
  function canvasOf(x) { if (!x) return null; if (typeof x === 'string') return doc.getElementById(x); if (x.canvas && x.canvas.tagName) return x.canvas; return x.tagName === 'CANVAS' ? x : null; }
  function merge(base, over) {
    if (!over) return base;
    Object.keys(over).forEach(function (k) {
      var v = over[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof v !== 'function' && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) merge(base[k], v);
      else base[k] = v;
    });
    return base;
  }
  // the legend: small square swatches, the labels uppercase, the theme's text
  function legendLabels(type, withValues) {
    var radial = /^(doughnut|pie|polarArea)$/.test(type || '');
    return { color: text(), boxWidth: 10, boxHeight: 10, usePointStyle: false, padding: 10, font: { size: 11, family: sans() },
      generateLabels: function (chart) {
        // a doughnut / pie lists its slices (the type's own generator), with the value; the rest list the datasets
        var gen = radial && Chart.overrides && Chart.overrides[type] && Chart.overrides[type].plugins && Chart.overrides[type].plugins.legend ? Chart.overrides[type].plugins.legend.labels.generateLabels : Chart.defaults.plugins.legend.labels.generateLabels;
        var items = gen(chart);
        items.forEach(function (it) {
          var label = String(it.text || '');
          if (radial && withValues) { var ds = chart.data.datasets[0] || {}; var v = (ds.data || [])[it.index]; if (v !== undefined && v !== null) label = label + ' ' + fmt.num(v); }
          it.text = label.toUpperCase(); it.fontColor = text();
        });
        return items;
      } };
  }
  function tooltip() { return { backgroundColor: themeColor('tooltip', '#f0f0f0'), titleColor: text(), bodyColor: text(), footerColor: muted(), borderColor: grid(), borderWidth: 1, padding: 8, titleFont: { size: 11, family: sans() }, bodyFont: { size: 11, family: sans() }, cornerRadius: 6, displayColors: true, boxWidth: 8, boxHeight: 8 }; }
  var WIDE = 24;   // categories from which a per-item chart's card spans the whole chart grid
  var MANY = 64;   // categories from which the bars thin out and the labels show every Nth (every bar still drawn and hoverable)
  function scaleDefaults(scale, isCategory, horizontal, type, many) {
    scale.grid = merge({ color: grid(), tickColor: grid() }, scale.grid || {});
    scale.border = merge({ color: grid() }, scale.border || {});
    scale.ticks = merge({ color: text(), font: { size: 11, family: isCategory && horizontal ? mono() : sans() }, maxRotation: isCategory && !horizontal && type === 'bar' ? 90 : 0 }, scale.ticks || {});
    // a bar chart's categories all get their label (rotated when they do not fit side by side); a line over many points thins its labels
    if (isCategory) {
      if (type === 'bar' && !many) scale.ticks.autoSkip = false;
      else if (type === 'bar') { scale.ticks.autoSkip = true; scale.ticks.maxRotation = 0; if (scale.ticks.maxTicksLimit === undefined) scale.ticks.maxTicksLimit = 32; }   // every Nth label; every bar is drawn and hoverable
      else if (scale.ticks.maxTicksLimit === undefined) scale.ticks.maxTicksLimit = 12;
    }
    // a horizontal bar's category label is cut with an ellipsis (the tooltip has the whole text); a value axis reads 1.2M, not 1,200,000
    if (isCategory && horizontal && !scale.ticks.callback) scale.ticks.callback = function (v) { return truncate(this.getLabelForValue(v), 28); };
    if (!isCategory && !scale.ticks.callback && !scale.ticks.format) scale.ticks.callback = function (v) { return typeof v === 'number' ? fmt.num(v) : v; };
    if (scale.title) scale.title = merge({ color: muted(), font: { size: 11 } }, scale.title);
    return scale;
  }
  // every dataset gets its colour from the palette (by role, else by index) unless it keeps its own (a function, or keepColor)
  function colourDatasets(type, datasets) {
    datasets.forEach(function (ds, i) {
      var keep = ds.keepColor || typeof ds.backgroundColor === 'function' || typeof ds.borderColor === 'function';
      if (ds.$diagColors) { ds.backgroundColor = ds.$diagColors.bg(); ds.borderColor = ds.$diagColors.border(); ds.hoverBackgroundColor = ds.backgroundColor; ds.hoverBorderColor = ds.borderColor; return; }
      if (keep) return;
      var perPoint = Array.isArray(ds.roles);
      var base = function () { return roleColor(ds.role, i); };
      if (type === 'line' || type === 'radar') {
        ds.$diagColors = { bg: function () { return rgba(base(), ds.fill ? 0.15 : 0.9); }, border: function () { return base(); } };
        if (ds.tension === undefined) ds.tension = 0;
        if (ds.spanGaps === undefined) ds.spanGaps = false;
        if (ds.borderWidth === undefined) ds.borderWidth = 2;
        if (ds.pointRadius === undefined) ds.pointRadius = (ds.data && ds.data.length > 60) ? 0 : 2.5;
      } else if (type === 'doughnut' || type === 'pie' || type === 'polarArea') {
        var p = palette();
        ds.$diagColors = { bg: function () { return (ds.data || []).map(function (_, k) { return perPoint ? roleColor(ds.roles[k], k) : p.series[k % p.series.length]; }); }, border: function () { return themeColor('card', '#fff'); } };
        if (ds.borderWidth === undefined) ds.borderWidth = 2;
      } else {
        ds.$diagColors = { bg: function () { return perPoint ? (ds.data || []).map(function (_, k) { return rgba(roleColor(ds.roles[k], k), 0.85); }) : rgba(base(), 0.85); }, border: function () { return perPoint ? (ds.data || []).map(function (_, k) { return roleColor(ds.roles[k], k); }) : base(); } };
        if (ds.borderRadius === undefined) ds.borderRadius = 2;
        if (ds.borderWidth === undefined) ds.borderWidth = 0;
      }
      ds.backgroundColor = ds.$diagColors.bg(); ds.borderColor = ds.$diagColors.border(); ds.hoverBackgroundColor = ds.backgroundColor; ds.hoverBorderColor = ds.borderColor;
    });
  }
  var CHART_MIN = 180, CHART_MAX = 480, CHART_DEFAULT = 280, CHART_RADIAL = 240, ROW_PX = 22;
  // The one bar sizing of every bar chart (vertical, horizontal, stacked, the histogram): the thickness follows the
  // category count so three bars are not matchsticks and 256 are not a wall, every bar keeps at least 2 px of length
  // (a 1 next to a 100,000 still shows), and no template sets barThickness / barPercentage of its own.
  // bucketPx: the histogram on the broken time axis (a linear scale) sizes each bar by the bucket's width instead
  function barSizing(categories, horizontal, bucketPx) {
    if (bucketPx) return { barThickness: Math.max(1, bucketPx * 0.9), maxBarThickness: undefined, minBarLength: 3 };
    var n = Math.max(1, Number(categories) || 1);
    var max = n <= 3 ? 56 : n <= 5 ? 44 : n <= 16 ? 28 : n <= 64 ? 18 : 10;
    if (horizontal) max = Math.min(max, ROW_PX - 6);
    return { maxBarThickness: max, barPercentage: 0.8, categoryPercentage: 0.9, minBarLength: 3 };   // 3 px asked: 2 px left after pixel alignment
  }
  function applyBarSizing(config) {
    var type = config.type || 'bar';
    var horizontal = config.options && config.options.indexAxis === 'y';
    var n = ((config.data && config.data.labels) || []).length || ((config.data && config.data.datasets && config.data.datasets[0] && config.data.datasets[0].data) || []).length;
    var sizing = barSizing(n, horizontal);
    (config.data && config.data.datasets || []).forEach(function (ds) {
      if (ds.type && ds.type !== 'bar') return;
      if (type !== 'bar' && !ds.type) return;
      if (ds.$value) return;   // a time-series bucket bar: sized by its bucket width in the axis helper
      Object.keys(sizing).forEach(function (k) { ds[k] = sizing[k]; });
    });
  }
  function clampHeight(h) { return Math.max(CHART_MIN, Math.min(CHART_MAX, Math.round(h))); }
  // Every chart sits in a .ui-chart box with an explicit pixel height (config.height, or ROW_PX per row for category
  // bars, clamped to CHART_MIN..CHART_MAX, else the default) and the same max-height: Chart.js fills the box
  // (responsive, no aspect ratio) and the box never follows the frame, so a frame that sizes itself to its content
  // cannot grow the chart which grows the frame. A template wrapper with its own fixed height (a Tailwind h-* class or
  // an inline height) keeps it, capped.
  function ensureBox(canvas, config) {
    var parent = canvas.parentElement;
    var box = parent && parent.classList.contains('ui-chart') ? parent : null;
    if (!box) {
      box = el('div', 'ui-chart');
      if (parent) parent.insertBefore(box, canvas);
      box.appendChild(canvas);
      // a parent the template sizes itself (an inline height, a Tailwind h-* class, or a height from its own
      // stylesheet such as the Audit histogram's .au-hist) is measured with the canvas out of the way: whatever is
      // left is the template's box, and the chart takes exactly that (capped), never more than its container
      var fixed = parent && (parent.style.height || /(^|\s)h-(\d+|\[[^\]]+\])(\s|$)/.test(parent.className || ''));
      var own = 0;
      if (parent && !fixed) { var was = box.style.display; box.style.display = 'none'; own = parent.clientHeight; box.style.display = was; }
      if (fixed) { var ph = parent.getBoundingClientRect().height; if (ph > 0) box.dataset.fixedHeight = String(Math.min(CHART_MAX, Math.round(ph))); }
      else if (own >= 40 && parent.children.length === 1) box.dataset.fixedHeight = String(Math.min(CHART_MAX, Math.round(own)));
    }
    // a template's own box with a pixel height (style="height: 470px") keeps it, capped; a height the template sets
    // anew before re-making the chart (Blame's "Show all") is read again, the one this helper set last is not
    var inline = box === parent && /^\d+(\.\d+)?px$/.test(box.style.height || '') ? Math.round(parseFloat(box.style.height)) : null;
    if (inline !== null && String(inline) !== box.dataset.diagHeight) box.dataset.fixedHeight = String(Math.min(CHART_MAX, Math.max(CHART_MIN, inline)));
    var radial = /^(doughnut|pie|polarArea|radar)$/.test(config.type || 'bar');
    var h;
    if (config.height) h = Math.min(CHART_MAX, Math.max(40, Number(config.height)));
    else if (box.dataset.fixedHeight) h = Number(box.dataset.fixedHeight);
    else if (config.rows) h = clampHeight(config.rows * ROW_PX + 30);
    else h = radial ? CHART_RADIAL : CHART_DEFAULT;
    box.style.height = h + 'px';
    box.style.maxHeight = h + 'px';
    box.style.minHeight = '0';
    box.style.overflow = 'hidden';   // the safety net: the canvas can never paint past its box
    box.dataset.diagHeight = String(h);
    return box;
  }
  // no data: the box and its card (the closest [data-chart-card]) are hidden - the Findings strip says why; a chart
  // that gets rows later shows again
  function setEmpty(canvas, empty) {
    var box = canvas.closest('.ui-chart') || canvas.parentElement; if (!box) return;
    var card = box.closest('[data-chart-card]');
    box.hidden = !!empty;
    if (card) card.hidden = !!empty;
    canvas.style.visibility = empty ? 'hidden' : '';
  }
  function emptyNote(canvas, show) { setEmpty(canvas, show); }
  function hasData(config) {
    var ds = (config.data && config.data.datasets) || [];
    return ds.some(function (d) { return (d.data || []).some(function (v) { if (v === null || v === undefined) return false; if (typeof v === 'object') return Array.isArray(v) ? v.length > 0 : (v.y !== null && v.y !== undefined); return true; }); });
  }
  // the empty state follows the data: a chart built with nothing shows the note, one that gets rows later drops it
  // A vertical bar chart's category labels never overlap: once the layout is known, the widest label is measured
  // against the room per tick and, when Chart.js's own rotation leaves them touching, the axis gets the rotation
  // that fits (up to 90 degrees) and the chart lays out once more.
  var rotatePlugin = { id: 'diagRotate', afterLayout: function (chart) {
    if (chart.config.type !== 'bar' || (chart.options && chart.options.indexAxis === 'y') || !chart.scales || !chart.scales.x) return;
    var x = chart.scales.x;
    if (x.type !== 'category' || !x.ticks || x.ticks.length < 2 || x.$diagRotated || (x.options.ticks && x.options.ticks.autoSkip)) return;
    var font = (x.options.ticks && x.options.ticks.font) || {};
    var ctx = chart.ctx; ctx.save(); ctx.font = (font.size || 11) + 'px ' + (font.family || sans());
    var widest = 0; x.ticks.forEach(function (t) { widest = Math.max(widest, ctx.measureText(String(t.label)).width); }); ctx.restore();
    var room = Math.abs(x.getPixelForTick(1) - x.getPixelForTick(0)) - 6;
    var rot = x.labelRotation || 0;
    if (widest * Math.cos(rot * Math.PI / 180) <= room) return;
    var needed = room > 0 ? Math.ceil(Math.acos(Math.max(0, room / widest)) * 180 / Math.PI) : 90;
    needed = Math.min(90, Math.max(needed, rot + 1));
    x.$diagRotated = true;
    x.options.ticks.minRotation = needed;
    x.options.ticks.maxRotation = Math.max(needed, x.options.ticks.maxRotation || 0);
    setTimeout(function () { try { chart.update('none'); } catch { /* gone */ } }, 0);
  } };
  // The value on each bar (config.valueLabels: true): after the bar's end, the number as fmt.num, in the text colour;
  // on a horizontal bar to the right, on a vertical one above, never outside the chart area
  var valueLabelsPlugin = { id: 'diagValueLabels', afterDatasetsDraw: function (chart, args, o) {
    if (!(o && o.on)) return;
    var ctx = chart.ctx, horizontal = chart.options.indexAxis === 'y', ca = chart.chartArea;
    ctx.save(); ctx.font = '10px ' + sans(); ctx.fillStyle = text();
    chart.data.datasets.forEach(function (ds, di) {
      var meta = chart.getDatasetMeta(di); if (meta.hidden) return;
      meta.data.forEach(function (bar, i) {
        var v = ds.data[i]; if (v === null || v === undefined || v === 0) return;
        var label = fmt.num(typeof v === 'object' ? (v.y !== undefined ? v.y : v.x) : v);
        if (horizontal) { ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; var x = Math.min(bar.x + 4, ca.right - ctx.measureText(label).width - 2); ctx.fillText(label, x, bar.y); }
        else { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; var y = Math.max(bar.y - 2, ca.top + 10); ctx.fillText(label, bar.x, y); }
      });
    });
    ctx.restore();
  } };
  var emptyPlugin = { id: 'diagEmpty', afterUpdate: function (chart) { var empty = !hasData(chart.config) || !(chart.data.labels || []).length && chart.config.type !== 'scatter' && !(chart.data.datasets || []).some(function (d) { return (d.data || []).some(function (v) { return v && typeof v === 'object'; }); }); setEmpty(chart.canvas, empty); } };
  function spread(config) {
    var vals = [];
    ((config.data && config.data.datasets) || []).forEach(function (d) { (d.data || []).forEach(function (v) { var n = typeof v === 'object' && v ? v.y : v; n = Number(n); if (Number.isFinite(n) && n > 0) vals.push(n); }); });
    if (vals.length < 2) return 1;
    return Math.max.apply(null, vals) / Math.min.apply(null, vals);
  }
  function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }
  function make(target, config) {
    var canvas = canvasOf(target);
    if (!canvas || typeof Chart !== 'function' || !config) return null;
    var old = Chart.getChart(canvas); if (old) { old.destroy(); registry = registry.filter(function (c) { return c !== old; }); }
    var box = ensureBox(canvas, config);
    config.plugins = (config.plugins || []).concat([emptyPlugin, rotatePlugin, valueLabelsPlugin]);
    config.options = config.options || {}; config.options.plugins = config.options.plugins || {};
    config.options.plugins.diagValueLabels = { on: !!config.valueLabels };   // read by the plugin on every draw, the first one included
    var type = config.type || 'bar';
    var radial = /^(doughnut|pie|polarArea|radar)$/.test(type);
    var horizontal = config.options && config.options.indexAxis === 'y';
    setEmpty(canvas, !hasData(config));
    if (type === 'bar' || (config.data && (config.data.datasets || []).some(function (d) { return d.type === 'bar'; }))) applyBarSizing(config);
    colourDatasets(type, (config.data && config.data.datasets) || []);
    var o = config.options = config.options || {};
    o.responsive = o.responsive !== false;
    if (o.maintainAspectRatio === undefined) o.maintainAspectRatio = false;
    if (reduced()) o.animation = false; else if (o.animation === undefined) o.animation = { duration: 200 };
    o.plugins = o.plugins || {};
    o.plugins.legend = merge({ display: true, position: 'bottom', labels: {} }, o.plugins.legend || {});
    o.plugins.legend.labels = merge(legendLabels(type, config.legendValues !== false), o.plugins.legend.labels || {});
    o.plugins.tooltip = merge(tooltip(), o.plugins.tooltip || {});
    if (radial) {
      delete o.scales;   // a doughnut / pie / radar has no cartesian axes: a template's x / y scales would draw a grid behind it
    } else {
      o.scales = o.scales || {};
      // values that spread 30x and more (a per-CPU count where one CPU does it all) go on a log scale, noted on the box
      var valueAxis = horizontal ? 'x' : 'y';
      if (config.logWhenSpread && spread(config) >= 30) { o.scales[valueAxis] = merge(o.scales[valueAxis] || {}, { type: 'logarithmic' }); box.dataset.scale = 'log'; } else delete box.dataset.scale;
      var note = box.querySelector(':scope > .ui-chart-note');
      if (box.dataset.scale === 'log') { if (!note) { note = el('div', 'ui-chart-note', 'log scale'); box.appendChild(note); } } else if (note) note.remove();
      o.scales.x = o.scales.x || {}; o.scales.y = o.scales.y || {};
      var catAxis = horizontal ? 'y' : 'x';
      var nCat = !horizontal && type === 'bar' ? ((config.data && config.data.labels) || []).length : 0;
      var many = nCat >= MANY;
      if (nCat > WIDE) { var wideCard = canvas.closest('[data-chart-card]'); if (wideCard && config.wide !== false) wideCard.setAttribute('data-wide', ''); }
      if (many) {
        // one bar per item on a wide row: the card spans the chart grid, the bars stay thin, a hover anywhere in the column finds the bar
        o.plugins.tooltip = merge(o.plugins.tooltip, { mode: 'index', intersect: false });
      }
      if (config.wide) { var wcard = canvas.closest('[data-chart-card]'); if (wcard) wcard.setAttribute('data-wide', ''); }
      Object.keys(o.scales).forEach(function (k) { var s = o.scales[k]; if (!s) return; var isCat = (k === catAxis && (!s.type || s.type === 'category')); scaleDefaults(s, isCat, horizontal, type, many); if (k !== catAxis && s.beginAtZero === undefined && type === 'bar') s.beginAtZero = true; });
    }
    if (type === 'line') { o.interaction = merge({ mode: 'index', intersect: false }, o.interaction || {}); }
    var chart = new Chart(canvas.getContext('2d'), config);
    chart.$diag = { type: type, horizontal: horizontal, box: box }
    if (config.valueLabels) chart.$diag.valueLabels = true;
    registry.push(chart);
    return chart;
  }
  // a theme switch: every colour is read again (the bridge re-themes ticks / grid / legend / tooltip; the datasets are ours)
  function retheme() {
    registry = registry.filter(function (c) { return c && c.canvas && c.canvas.isConnected; });
    registry.forEach(function (chart) {
      try {
        var o = chart.options || {};
        (chart.data.datasets || []).forEach(function (ds) { if (ds.$diagColors) { ds.backgroundColor = ds.$diagColors.bg(); ds.borderColor = ds.$diagColors.border(); ds.hoverBackgroundColor = ds.backgroundColor; ds.hoverBorderColor = ds.borderColor; } });
        if (o.plugins && o.plugins.legend && o.plugins.legend.labels) o.plugins.legend.labels.color = text();
        if (o.plugins && o.plugins.tooltip) { var t = tooltip(); Object.keys(t).forEach(function (k) { o.plugins.tooltip[k] = t[k]; }); }
        Object.keys(o.scales || {}).forEach(function (k) { var s = o.scales[k]; if (!s) return; if (s.ticks) s.ticks.color = text(); if (s.grid) { s.grid.color = grid(); s.grid.tickColor = grid(); } if (s.border) s.border.color = grid(); if (s.title) s.title.color = muted(); });
        chart.update('none');
      } catch { /* a chart mid-destroy */ }
    });
    return registry.length;
  }
  // ---- the broken time axis (from the Audit page): buckets with gap items between capture windows ----
  function axis(buckets, step) {
    var a = { buckets: buckets, step: step, points: [], gaps: [], G: step * 4, min: 0, max: 0, ticks: [], labels: new Map(), windows: [] };
    a.layout = function (plotWidth) {
      var nGaps = buckets.filter(function (b) { return b.gap; }).length;
      var active = buckets.filter(function (b) { return !b.gap; }).length * step;
      a.G = nGaps && plotWidth > BREAK_PX * (nGaps + 2) ? active * BREAK_PX / (plotWidth - BREAK_PX * nGaps) : step * 4;
      var x = 0; a.points = []; a.gaps = []; a.windows = []; a.labels = new Map(); a.ticks = [];
      var win = null;
      buckets.forEach(function (b, i) {
        if (b.gap) { a.gaps.push({ x0: x, x1: x + a.G, mid: x + a.G / 2, label: b.label, from: b.from, to: b.to, minutes: b.minutes, index: i }); x += a.G; win = null; return; }
        if (!win) { win = { x0: x, x1: x, first: b.t, last: b.t, buckets: 0 }; a.windows.push(win); }
        a.points.push({ x: x + step / 2, start: x, t: b.t, label: b.label, index: i, bucket: b });
        a.labels.set(x, b.label);
        win.x1 = x + step; win.last = b.t; win.buckets += 1;
        x += step;
      });
      a.min = 0; a.max = x || step;
      a.plotWidth = plotWidth;
      var maxTicks = Math.max(3, Math.min(12, Math.floor(plotWidth / 75)));
      var k = Math.max(1, Math.ceil(a.points.length / maxTicks));
      var n = 0;
      a.points.forEach(function (p) { var s = p.bucket.start; if (s) n = 0; if (s || n % k === 0) a.ticks.push({ value: p.start, label: p.label }); n += 1; });
      return a;
    };
    a.layout(600);
    a.plugin = {
      id: 'diagBrokenAxis',
      afterLayout: function (chart) {
        var w = chart.chartArea ? chart.chartArea.width : 0;
        if (!w) return;
        var want = a.gaps.length ? buckets.filter(function (b) { return !b.gap; }).length * step * BREAK_PX / Math.max(1, w - BREAK_PX * a.gaps.length) : a.G;
        var widthMoved = Math.abs(w - (a.plotWidth || 0)) > 60;
        if ((widthMoved || Math.abs(want - a.G) > a.G * 0.15) && !chart.$relayout) { chart.$relayout = true; a.layout(w); a.apply(chart); setTimeout(function () { chart.$relayout = false; try { chart.update('none'); } catch { /* gone */ } }, 0); }
      },
      beforeDatasetsDraw: function (chart) {
        if (!a.gaps.length) return;
        var ctx = chart.ctx, ca = chart.chartArea, xs = chart.scales.x;
        chart.$gaps = [];
        ctx.save();
        a.gaps.forEach(function (g) {
          var x0 = xs.getPixelForValue(g.x0), x1 = xs.getPixelForValue(g.x1);
          chart.$gaps.push({ x0: x0, x1: x1, label: g.label, from: g.from, to: g.to });
          ctx.fillStyle = rgba(text(), 0.06); ctx.fillRect(x0, ca.top, x1 - x0, ca.bottom - ca.top);
          ctx.strokeStyle = rgba(text(), 0.18); ctx.lineWidth = 1;
          ctx.beginPath();
          for (var x = x0 - (ca.bottom - ca.top); x < x1; x += 6) { ctx.moveTo(Math.max(x0, x), x < x0 ? ca.top + (x0 - x) : ca.top); ctx.lineTo(Math.min(x1, x + (ca.bottom - ca.top)), x + (ca.bottom - ca.top) > x1 ? ca.top + (x1 - x) : ca.bottom); }
          ctx.stroke();
          // the band's own label only when the plot is tall enough to carry it upright; a short chart leaves the
          // words to the note the page renders below the chart
          if (ca.bottom - ca.top >= 150) {
            ctx.fillStyle = text(); ctx.font = '10px ' + sans(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.translate((x0 + x1) / 2, (ca.top + ca.bottom) / 2); ctx.rotate(-Math.PI / 2);
            ctx.fillText(g.label, 0, 0, ca.bottom - ca.top - 8);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
          }
        });
        ctx.restore();
      },
      afterDraw: function (chart) {
        if (!a.gaps.length) return;
        var ctx = chart.ctx, ca = chart.chartArea, xs = chart.scales.x;
        ctx.save(); ctx.strokeStyle = grid(); ctx.lineWidth = 1.5;
        a.gaps.forEach(function (g) {
          var x0 = xs.getPixelForValue(g.x0), x1 = xs.getPixelForValue(g.x1);
          ctx.beginPath(); ctx.moveTo(x0, ca.bottom);
          var up = true;
          for (var x = x0 + 3; x <= x1; x += 3) { ctx.lineTo(x, ca.bottom + (up ? -4 : 4)); up = !up; }
          ctx.lineTo(x1, ca.bottom); ctx.stroke();
        });
        ctx.restore();
      },
    };
    a.scale = function () { return { type: 'linear', min: 0, max: a.max, offset: false, grid: { color: grid() },
      afterBuildTicks: function (scale) { scale.ticks = a.ticks.map(function (t) { return { value: t.value, label: t.label }; }); },
      ticks: { color: text(), font: { size: 11 }, autoSkip: false, maxRotation: 0, includeBounds: false, callback: function (v) { return a.labels.get(v) || ''; } } }; };
    a.apply = function (chart) {
      chart.options.scales.x.max = a.max;
      var px = (a.plotWidth || 600) * step / Math.max(a.max, step);
      chart.data.datasets.forEach(function (ds) { if (ds.$value) { ds.data = a.series(ds.$value); Object.assign(ds, barSizing(0, false, px)); } });
    };
    a.series = function (value) { return a.points.map(function (p) { return { x: p.x, y: value(p.bucket), t: p.bucket.t, label: p.label, bucket: p.bucket }; }); };
    return a;
  }
  // a bar chart over time buckets on the broken axis; series: [{ label, role, value(bucket) }]
  function timeSeries(target, spec) {
    var canvas = canvasOf(target);
    if (!canvas || typeof Chart !== 'function') return null;
    var b = (spec && spec.buckets) || [];
    var real = b.filter(function (x) { return !x.gap; }).length;
    var old = Chart.getChart(canvas); if (old) { old.destroy(); registry = registry.filter(function (c) { return c !== old; }); }
    if (real < 1) { emptyNote(canvas, true, spec && spec.emptyText); return null; }
    var step = spec.step || 60;
    var ax = axis(b, step);
    var range = function (t) { if (!t) return ''; var start = t.replace('T', ' '); var d = new Date(t + 'Z'); d.setUTCSeconds(d.getUTCSeconds() + step - 1); var end = d.toISOString().slice(11, 19); return start.length > 16 ? start + ' – ' + end : start + ':00 – ' + end; };
    var datasets = (spec.series || []).map(function (s, i) {
      return { label: s.label, role: s.role, $value: s.value, data: ax.series(s.value), parsing: false, keepColor: true,
        backgroundColor: function () { return rgba(roleColor(s.role, i), 0.85); }, borderRadius: 2 };
    });
    var onBucket = spec.onBucket;
    var chart = make(canvas, {
      type: spec.type || 'bar',
      plugins: [ax.plugin],
      data: { datasets: datasets },
      options: { interaction: { mode: 'index', intersect: false },
        onClick: function (evt, items, c) { if (!onBucket) return; var pts = c.getElementsAtEventForMode(evt, 'index', { intersect: false }, false); var p = pts.length ? c.data.datasets[0].data[pts[0].index] : null; if (p && p.bucket) onBucket(p.bucket); },
        plugins: { legend: { display: !!spec.legend }, tooltip: { callbacks: { title: function (items) { return range(items[0].raw.t); }, afterBody: function () { return [onBucket ? 'click: filter to this time' : '']; } } } },
        scales: { x: merge(ax.scale(), { stacked: spec.stacked !== false }), y: { stacked: spec.stacked !== false, beginAtZero: true, ticks: { font: { size: 10 }, maxTicksLimit: 4, precision: 0 } } } },
    });
    if (chart) { chart.$axis = ax; ax.apply(chart); }
    return chart;
  }
  // horizontal bars, one per row ({name, count, errors?}); colour(row) → css colour for the plain form; onRow(row) on a click
  // The capacity marker of a category bar (a pods-per-node chart): a tick at the row's capacity and "count / capacity"
  // after the bar, in the warn colour from 80% and the bad colour from 95% (the Findings thresholds, parsers/findings.py)
  var capacityPlugin = { id: 'diagCapacity', afterDatasetsDraw: function (chart) {
    var rows = chart.$diagRows, capOf = chart.$diagCapacity;
    if (!rows || !capOf || !chart.scales.x || !chart.scales.y) return;
    var x = chart.scales.x, y = chart.scales.y, ctx = chart.ctx, p = palette();
    ctx.save(); ctx.font = '10px ' + sans(); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    rows.forEach(function (r, i) {
      var cap = capOf(r);
      if (!cap) return;
      var yc = y.getPixelForValue(i), pct = 100 * (r.count || 0) / cap;
      var col = pct >= 95 ? p.bad : pct >= 80 ? p.warn : muted();
      // the tick at the capacity when it falls inside the axis (a near-full node); the label after the bar always
      if (cap <= x.max) { var px = x.getPixelForValue(cap); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, yc - 8); ctx.lineTo(px, yc + 8); ctx.stroke(); }
      ctx.fillStyle = col; ctx.fillText(fmt.num(r.count || 0) + ' / ' + fmt.num(cap), x.getPixelForValue(Math.min(r.count || 0, x.max)) + 5, yc);
    });
    ctx.restore();
  } };
  // Horizontal bars, one row per entry ({name, count, title?, role?, errors?, values?}), ROW_PX per row: the rows'
  // own roles colour the bars (opts.colour(row) overrides), opts.stacks = [{key, label, role}] stacks one dataset per
  // key (row.values[key], or opts.valueOf(row, key)) with the totals in the legend, opts.capacity(row) draws the
  // capacity marker, opts.onRow(row) runs on a click (the tooltip says so), opts.format(value) prints the numbers.
  function categoryBars(target, rows, opts) {
    var canvas = canvasOf(target);
    opts = opts || {};
    if (!canvas || typeof Chart !== 'function') return null;
    var old = Chart.getChart(canvas); if (old) { old.destroy(); registry = registry.filter(function (c) { return c !== old; }); }
    if (!rows.length) { setEmpty(canvas, true); return null; }
    var stacks = opts.stacks;
    var valueOf = opts.value || function (r, k) { return (r.values && r.values[k]) || 0; };   // (opts.valueOf would be Object.prototype's)
    var stacked = stacks ? true : (opts.stacked !== undefined ? opts.stacked : rows.some(function (r) { return typeof r.errors === 'number'; }));
    var datasets;
    if (stacks) {
      datasets = stacks.map(function (st) {
        var data = rows.map(function (r) { return Number(valueOf(r, st.key)) || 0; });
        var sum = data.reduce(function (acc, v) { return acc + v; }, 0);
        return { label: st.label + (opts.legendCounts === false ? '' : ' ' + fmt.num(sum)), $label: st.label, role: st.role, data: data };
      });
    } else if (stacked) {
      datasets = [{ label: 'ok', role: 'ok', data: rows.map(function (r) { return r.count - (r.errors || 0); }) }, { label: 'errors', role: 'error', data: rows.map(function (r) { return r.errors || 0; }) }];
    } else {
      datasets = [{ label: opts.label || 'count', data: rows.map(function (r) { return r.count; }), keepColor: true, backgroundColor: function (ctx) { var r = rows[ctx.dataIndex] || {}; return opts.colour ? opts.colour(r) : (r.role ? roleColor(r.role, ctx.dataIndex) : accent()); }, borderRadius: 2 }];
    }
    var onRow = opts.onRow;
    var format = opts.format || function (v) { return fmt.num(v); };
    var capOf = opts.capacity || null;
    var chart = make(canvas, {
      type: 'bar',
      rows: rows.length,
      height: opts.height,
      plugins: capOf ? [capacityPlugin] : [],
      data: { labels: rows.map(function (r) { return r.name; }), datasets: datasets },
      options: { indexAxis: 'y',
        layout: capOf ? { padding: { right: 72 } } : {},
        onClick: function (evt, items, c) { if (!onRow) return; var pts = c.getElementsAtEventForMode(evt, 'index', { intersect: false }, false); if (pts.length) onRow(rows[pts[0].index]); },
        plugins: { legend: { display: !!(opts.legend || stacks), position: 'bottom' }, tooltip: { mode: 'index', callbacks: {
          title: function (items) { var r = rows[items[0].dataIndex] || {}; return r.title || r.name; },
          label: function (item) { if (stacks && !item.raw) return null; var r = rows[item.dataIndex] || {}; var lab = item.dataset.$label || item.dataset.label; return (lab ? lab + ': ' : '') + format(item.raw, r); },
          afterBody: function (items) { var r = rows[items[0].dataIndex] || {}; var lines = opts.tooltip ? (opts.tooltip(r) || []) : []; if (capOf && capOf(r)) lines = lines.concat(['capacity ' + fmt.num(capOf(r)) + ' pods (' + Math.round(100 * (r.count || 0) / capOf(r)) + '%)']); if (onRow) lines = lines.concat(['click: filter to this']); return lines; } } } },
        scales: { x: { stacked: stacked, beginAtZero: true, ticks: { font: { size: 10 }, maxTicksLimit: 5, precision: 0, callback: function (v) { return format(v); } } }, y: { stacked: stacked, grid: { display: false }, ticks: { font: { size: 10.5, family: mono() } } } } },
    });
    if (chart) { chart.$diagRows = rows; chart.$diagCapacity = capOf; if (opts.valueLabels) { chart.$diag.valueLabels = true; chart.options.plugins.diagValueLabels = { on: true }; chart.update('none'); } }
    return chart;
  }
  window.diagChart = { barSizing: barSizing, make: make, timeSeries: timeSeries, categoryBars: categoryBars, retheme: retheme, axis: axis, palette: palette, roleColor: roleColor, fmt: fmt, norm: norm, rgba: rgba, token: token, theme: themeColor, accent: accent, text: text, muted: muted, grid: grid, BREAK_PX: BREAK_PX, charts: function () { return registry.slice(); }, truncate: truncate, CHART_MIN: CHART_MIN, CHART_MAX: CHART_MAX, ROW_PX: ROW_PX };
})();

/*
  Cross-links: a Findings row's Open button, or any element carrying data-tab,
  asks the parent for another tab of the same report (the open-tab bridge of
  DiagnosticsPage); with a data-query the parent hands the term to the new
  page once it is up, and the page applies it to its main search field - the
  ONE input a page marks with data-ui-search (an input event follows, so the
  page's own filter runs). diagLinks.applyQuery(q) is also callable directly.
*/
(function () {
  var doc = document;
  function applyQuery(q) {
    var field = doc.querySelector('[data-ui-search]');
    if (!field || !q) return false;
    field.value = q;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    return true;
  }
  doc.addEventListener('click', function (ev) {
    var a = ev.target.closest ? ev.target.closest('[data-tab]') : null;
    if (!a || !window.diagnosticsOpenTab) return;
    ev.preventDefault();
    window.diagnosticsOpenTab(a.getAttribute('data-tab'), a.getAttribute('data-sub-tab') || null, a.getAttribute('data-query') || null);
  });
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (d && d.__diagnosticsApi === true && d.dir === 'down' && d.type === 'apply-query') applyQuery(String(d.query || ''));
  });
  window.diagLinks = { applyQuery: applyQuery };
})();

/*
  diagPager: the one pagination component of the Diagnostics tables.
  diagPager.render(container, { page, total, pageSize, go, pages, label })
  draws into the container (a <nav class="ui-pager">): First / Prev as
  chevrons, a window of page numbers around the current one with the first
  and the last always there (muted ellipses between), Next / Last, and - over
  ten pages - a "Go to page" box (Enter jumps). Every button is a .btn of the
  secondary role at the shared control height; the current page is the
  selected role with aria-current="page"; the ends are disabled on the first
  and the last page. Under 640px the numbers give way to "Page N of M" (CSS).
  Nothing is drawn when everything fits on one page.
  diagPager.status(el, { start, end, total, unit, filteredFrom }) writes the
  "Showing 1-100 of 27,527 lines" text.
*/
(function () {
  var doc = document;
  var CHEV = { first: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m11 17-5-5 5-5M18 17l-5-5 5-5"/></svg>', prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>', next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>', last: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 17 5-5-5-5M13 17l5-5-5-5"/></svg>' };
  function num(n) { return Number(n || 0).toLocaleString('en-US'); }
  function windowOf(page, pages) {
    // 1 … 4 5 [6] 7 8 … 276: the current page with two neighbours, the first and the last always
    var set = {};
    [1, pages, page - 2, page - 1, page, page + 1, page + 2].forEach(function (p) { if (p >= 1 && p <= pages) set[p] = true; });
    var out = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    var items = [];
    out.forEach(function (p, i) { if (i && p - out[i - 1] > 1) items.push({ gap: true }); items.push({ page: p }); });
    return items;
  }
  function render(container, opts) {
    if (!container) return;
    container.classList.add('ui-pager');
    if (!container.getAttribute('aria-label')) container.setAttribute('aria-label', 'Pages');
    var pageSize = Number(opts.pageSize);
    var pages = opts.pages !== undefined ? Number(opts.pages) : (pageSize > 0 ? Math.ceil(Number(opts.total || 0) / pageSize) : 1);
    var page = Math.min(Math.max(1, Number(opts.page || 1)), Math.max(1, pages));
    container.innerHTML = '';
    if (!(pages > 1)) { container.hidden = true; return; }
    container.hidden = false;
    var go = function (p) { p = Math.min(Math.max(1, p), pages); if (p !== page && typeof opts.go === 'function') opts.go(p); };
    function button(kind, p, label, disabled) {
      var b = doc.createElement('button'); b.type = 'button'; b.className = 'btn btn-secondary btn-sm ui-pager-btn ui-pager-' + kind;
      b.innerHTML = CHEV[kind] + '<span class="ui-sr">' + label + '</span>'; b.title = label; b.disabled = !!disabled;
      b.addEventListener('click', function () { go(p); });
      return b;
    }
    container.appendChild(button('first', 1, 'First page', page === 1));
    container.appendChild(button('prev', page - 1, 'Previous page', page === 1));
    var numbers = doc.createElement('span'); numbers.className = 'ui-pager-numbers';
    windowOf(page, pages).forEach(function (it) {
      if (it.gap) { var g = doc.createElement('span'); g.className = 'ui-pager-gap'; g.textContent = '\u2026'; g.setAttribute('aria-hidden', 'true'); numbers.appendChild(g); return; }
      var b = doc.createElement('button'); b.type = 'button'; b.textContent = num(it.page);
      b.className = 'btn btn-sm ui-pager-btn ui-pager-page ' + (it.page === page ? 'btn-selected' : 'btn-secondary');
      if (it.page === page) b.setAttribute('aria-current', 'page');
      b.setAttribute('aria-label', 'Page ' + num(it.page));
      b.addEventListener('click', function () { go(it.page); });
      numbers.appendChild(b);
    });
    container.appendChild(numbers);
    var compact = doc.createElement('span'); compact.className = 'ui-pager-compact'; compact.textContent = 'Page ' + num(page) + ' of ' + num(pages); container.appendChild(compact);
    container.appendChild(button('next', page + 1, 'Next page', page === pages));
    container.appendChild(button('last', pages, 'Last page', page === pages));
    if (pages > 10) {
      var jump = doc.createElement('label'); jump.className = 'ui-pager-goto';
      var input = doc.createElement('input'); input.type = 'number'; input.min = '1'; input.max = String(pages); input.className = 'ui-input'; input.placeholder = 'Go to'; input.setAttribute('aria-label', 'Go to page'); input.title = 'Go to page (Enter)';
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var p = parseInt(input.value, 10); if (p >= 1 && p <= pages) { go(p); } } });
      jump.appendChild(input);
      container.appendChild(jump);
    }
  }
  function status(el, opts) {
    if (!el) return;
    var unit = opts.unit || 'rows';
    var total = Number(opts.total || 0);
    var text = total ? 'Showing ' + num(opts.start) + '\u2013' + num(opts.end) + ' of ' + num(total) + ' ' + unit : 'No ' + unit;
    if (opts.filteredFrom && opts.filteredFrom !== total) text += ' (filtered from ' + num(opts.filteredFrom) + ')';
    if (opts.extra) text += ' ' + opts.extra;
    el.textContent = text;
  }
  window.diagPager = { render: render, status: status, windowOf: windowOf };
})();

/*
  diagDetails: every folded block (<details>) opens and closes with the
  pointer and the keyboard, and the frame follows its height. The frame
  reports its height from a ResizeObserver on the body; a toggle inside a
  card changes it, so a resize event is raised on every toggle (and the
  height reporter runs), and a summary's click never bubbles into another
  handler that would read it as a row click.
*/
(function () {
  document.addEventListener('toggle', function () { try { window.dispatchEvent(new Event('resize')); } catch { /* no window */ } }, true);
  document.addEventListener('click', function (ev) {
    var s = ev.target.closest ? ev.target.closest('summary') : null;
    if (s) ev.stopPropagation();   // a row's own click handler (an expandable table row) must not undo the toggle
  }, false);
})();
