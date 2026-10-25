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
      rows: [{ name (shown), key (the exact filter value, else the name), count, other (not clickable) }]
    make(canvas, { ..., onPick(pick) })  the one click resolver of a chart: pick = { index, label, key, value,
      datasetLabel, row } from Chart.js's own hit test on the orientation's axis; data.keys[i] holds the filter
      value beside each label, data.others[i] marks a bucket that is not clickable; the pointer shows only there
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

  /* ------------------------------------------------------------------ */
  /* diagTables.fit: every table fits its box, no sideways scroll.       */
  /*                                                                    */
  /* The table gets table-layout: fixed and a <colgroup> whose widths    */
  /* come from the columns' content (a sample of rows, measured with    */
  /* the table's font) and the template's hints on the header cells:    */
  /*   data-w="num|status|narrow|text|wide|flex|wrap"  the column kind  */
  /*     num     a number: right-aligned, as wide as its widest value   */
  /*     status  badges / chips / meters: as wide as the widest one     */
  /*     narrow  a short word (a namespace, an age, a type)             */
  /*     text    a longer value: up to ~280 px, wrapping past it         */
  /*     wide    a long value that reads whole, up to 420 px, wrapping   */
  /*     flex    THE one flexible column: it takes what is left and     */
  /*             wraps (natural breaks first, <wbr> after / . _ : =)     */
  /*     wrap    the same, for a message                                */
  /*     clamp   a long-content column (a command line, a log message): */
  /*             three lines, a click opens the whole value             */
  /*   Text never cuts with an ellipsis; numbers, badges and the chevron */
  /*   stay on one line at their natural width.                         */
  /*   data-p="1|2|3"  the priority: when the box is too narrow for the */
  /*     columns, priority 3 hides first, then 2; 1 (the default), the  */
  /*     first column and the flexible one never hide. A hidden         */
  /*     column's values move into the row's details panel and a line  */
  /*     under the table names them; the stacked layout (<= 640 px)     */
  /*     shows everything again.                                        */
  /* Without hints the kinds are guessed from the cells (numbers,       */
  /* chips, short words; the widest text column is the flexible one).   */
  /* Only when even the compact widths do not fit does the table keep  */
  /* its width and scroll sideways (class ui-wide: a sticky first       */
  /* column and a "scroll" hint under the box) - the last resort.       */
  /* ------------------------------------------------------------------ */
  var FIT_SAMPLE = 80, FIT_PAD = 20, FIT_FLEX_MIN = 240, FIT_FLOOR = 64;
  var fitCtx = null;
  function textWidth(text, font) { if (!fitCtx) fitCtx = doc.createElement('canvas').getContext('2d'); fitCtx.font = font; return fitCtx.measureText(text).width; }
  // the font of an element as the canvas wants it (the computed shorthand is not reliable across browsers)
  function fontOf(node) { var cs = getComputedStyle(node); return (cs.fontStyle !== 'normal' ? cs.fontStyle + ' ' : '') + (cs.fontWeight || '400') + ' ' + (cs.fontSize || '12px') + ' ' + (cs.fontFamily || 'sans-serif'); }
  // a header's width: its longest word at least (a word cannot wrap), else about half of it plus a little (two lines)
  function headWidth(th, font) {
    var cs = getComputedStyle(th);
    var text = th.textContent.replace(/\s+/g, ' ').trim(); if (!text) return 0;
    if (cs.textTransform === 'uppercase') text = text.toUpperCase();
    var spacing = parseFloat(cs.letterSpacing) || 0;   // per character, on top of the glyphs
    var longest = 0; text.split(' ').forEach(function (w) { longest = Math.max(longest, textWidth(w, font) + spacing * w.length); });
    var whole = textWidth(text, font) + spacing * text.length;
    return Math.max(longest, Math.min(whole, whole / 2 + 14)) + (th.hasAttribute('aria-sort') ? 12 : 4);   // the sort marker after the active column's label
  }
  // a figure: a number with its unit (57.4 GiB, 88.6 %), a time (12:30:45, 2658:51), a ratio (3 / 38000), a dash
  var NUMERIC = /^[-+]?[\d.,:/\s]*\d[\d.,%:/\s]*(\s*[a-zA-Z%/µ]{0,6})?$|^-$|^n\/a$/i;
  // the width a cell's content asks for, measured (never read back from the layout: a wrapped text node's box is
  // the cell's own width, and a percentage bar scales with it): the text in the cell's font, plus a chip's padding
  // and gap for every badge / chip / flag / button on the line, a bar's room, a meter's minimum
  function contentExtent(td, text, font) {
    var w = textWidth(text, font);
    var chips = td.querySelectorAll('.ui-chip, .ui-badge, .ui-flag, button:not(.ui-xrow-btn), .ui-tag, .bl-tag').length;
    w += chips * 22;
    if (td.querySelector('.ui-bar, .bl-bar')) w += 70;
    if (td.querySelector('.ui-meter')) w = Math.max(w, 150);
    if (td.querySelector('svg, img')) w += 20;
    return Math.min(w, 480);
  }
  function fitColumns(table) {
    var ths = Array.prototype.slice.call(table.tHead ? table.tHead.querySelectorAll('th') : []);
    if (!ths.length) return [];
    var rows = Array.prototype.slice.call(table.tBodies[0] ? table.tBodies[0].rows : []).filter(function (r) { return !r.classList.contains('ui-xrow-panel') && !r.hidden && r.style.display !== 'none' && !(r.cells[0] && r.cells[0].colSpan > 1); }).slice(0, FIT_SAMPLE);
    var tfont = fontOf(table), hfont = fontOf(ths[0]);
    return ths.map(function (th, i) {
      var hint = (th.getAttribute('data-w') || '').trim(), max = 0, widest = 0, numeric = rows.length > 0, chips = 0;
      var first = rows[0] && rows[0].cells[i];
      var font = first ? fontOf(first) : tfont;   // the column's own font (a mono cell is wider than the table's text)
      rows.forEach(function (r) {
        var td = r.cells[i]; if (!td) return;
        var t = td.textContent.replace(/\s+/g, ' ').trim();
        var rich = td.querySelector('.ui-chip, .ui-badge, .ui-meter, .ui-flag, .ui-chips, .ui-bar, input, select, button:not(.ui-xrow-btn), svg');
        if (rich) chips++;
        if (t && !NUMERIC.test(t)) numeric = false;
        if (t.length > max) max = t.length;
        var w = td.children.length ? contentExtent(td, t, font) : textWidth(t, font);
        if (w > widest) widest = w;
      });
      var kind = hint;
      if (th.classList.contains('ui-xrow-th')) kind = 'icon';
      else if (!kind) {
        if (th.classList.contains('ui-num') || (numeric && max > 0)) kind = 'num';
        else if (chips && chips >= rows.length / 2) kind = 'status';
        else if (max <= 18) kind = 'narrow';
        else kind = 'text';
      }
      var head = headWidth(th, hfont);
      var hard = 0;   // the widest badge / chip: it cannot wrap, the column never shrinks under it
      rows.forEach(function (r) { var td = r.cells[i]; if (!td) return; Array.prototype.forEach.call(td.querySelectorAll('.ui-badge, .ui-chip, .ui-flag, .bl-tag'), function (ch) { hard = Math.max(hard, textWidth(ch.textContent.replace(/\s+/g, ' ').trim(), font) + 22); }); });
      return { kind: kind, max: max, widest: widest, head: head, hard: hard, p: Number(th.getAttribute('data-p') || 1) || 1 };
    });
  }
  function fitTable(table) {
    var wrap = table.parentElement && table.parentElement.classList.contains('ui-table-wrap') ? table.parentElement : null;
    if (!wrap || !table.tHead || table.classList.contains('lc-table') || table.closest('.au-diff') || table.hasAttribute('data-nofit')) return;
    if (doc.documentElement.clientWidth <= 640) { table.classList.remove('ui-fit', 'ui-wide'); wrap.classList.remove('ui-wide'); table.style.width = ''; if (table.$autoXrows) autoXrows(table, false); return; }   // the stacked layout shows every column
    var avail = wrap.clientWidth - 2;
    if (avail < 120 || !table.tBodies[0] || !table.tBodies[0].rows.length) return;
    var cols = fitColumns(table);
    if (!cols.length) return;
    var sig = avail + ':' + table.tBodies[0].rows.length + ':' + cols.map(function (c) { return c.kind + Math.round(c.widest) + '/' + Math.round(c.head); }).join(',');
    var stale = Array.prototype.some.call(table.tBodies[0].rows, function (r) { return !r.classList.contains('ui-xrow-panel') && r.cells[0] && r.cells[0].colSpan === 1 && !/\bui-col-/.test(r.cells[0].className); });
    if (table.$fitSig === sig && !stale) { titleTruncated(table); return; }   // nothing changed: no writes (the mutation observer would re-run on them)
    table.$fitSig = sig;
    var want = cols.map(function (c) {
      var head2 = c.head;   // the header's need: its longest word, or two lines of it
      if (c.kind === 'icon') return 30;
      if (c.kind === 'num') return Math.ceil(Math.max(c.widest * 1.08, head2, 36) + FIT_PAD);   // tabular digits run wider than the measure
      if (c.kind === 'status') return Math.ceil(Math.max(c.widest, head2, 48) + FIT_PAD);
      if (c.kind === 'narrow') return Math.ceil(Math.max(Math.min(c.widest, 200), head2, 48) + FIT_PAD);   // past 200 px a namespace wraps
      if (c.kind === 'wide') return Math.ceil(Math.min(Math.max(c.widest, 160), 420) + FIT_PAD);
      if (c.kind === 'flex' || c.kind === 'wrap' || c.kind === 'clamp') return 0;
      return Math.ceil(Math.min(Math.max(c.widest, 80), 280) + FIT_PAD);   // text: wraps past 280 px
    });
    // a table inside a row's details is compact: every column at its content, the text column capped at 40ch
    var nested = !!table.closest('.ui-xrow-body, .ui-xrow-panel, .ui-detail-section-body');
    var CH40 = Math.round(40 * (parseFloat(getComputedStyle(table).fontSize) || 12.5) * 0.6);
    var flex = -1;
    cols.forEach(function (c, i) { if (flex < 0 && (c.kind === 'flex' || c.kind === 'wrap' || c.kind === 'clamp')) flex = i; });
    if (flex < 0) { cols.forEach(function (c, i) { if ((c.kind === 'text' || c.kind === 'wide') && (flex < 0 || c.widest > cols[flex].widest)) flex = i; }); }
    if (flex >= 0) want[flex] = 0;
    if (nested && flex >= 0) { want[flex] = Math.ceil(Math.min(Math.max(cols[flex].widest, 60), CH40) + FIT_PAD); flex = -1; }   // compact: no column stretches
    var hidden = cols.map(function () { return false; });
    var flexMin = Math.max(FIT_FLEX_MIN, Math.round(avail * 0.25));   // the primary column keeps a quarter of the box at least
    var need = function () { var s = 0; want.forEach(function (w, i) { if (!hidden[i]) s += w; }); return s + (flex >= 0 ? flexMin : 0); };
    // too wide for the box, in this order: the long text columns cut to 180 px (an ellipsis, the title); the
    // low-priority columns hidden one at a time, the widest first (3 before 2), only while it is still too wide;
    // never the first column or the flexible one
    if (need() > avail) cols.forEach(function (c, i) { if (i !== flex && (c.kind === 'text' || c.kind === 'wide') && want[i] > 180 + FIT_PAD) want[i] = 180 + FIT_PAD; });
    [3, 2].forEach(function (p) {
      var order = []; cols.forEach(function (c, i) { if (c.p === p && i !== flex && i !== 0 && c.kind !== 'icon') order.push(i); });
      order.sort(function (x, y) { return want[y] - want[x]; });
      order.forEach(function (i) { if (need() > avail) hidden[i] = true; });
    });
    // still too wide: the text columns shrink together down to a floor
    var over = need() - avail;
    if (over > 0) {
      // a column never shrinks below its header's longest word (plus the padding) or the floor
      var floorOf = function (i) { return Math.max(FIT_FLOOR, Math.ceil(cols[i].head) + FIT_PAD, Math.ceil(cols[i].hard) + FIT_PAD); };
      var ids = []; cols.forEach(function (c, i) { if (!hidden[i] && i !== flex && c.kind !== 'icon' && c.kind !== 'num') ids.push(i); });
      var room = 0; ids.forEach(function (i) { room += Math.max(0, want[i] - floorOf(i)); });
      var k = room > 0 ? Math.min(1, over / room) : 0;
      ids.forEach(function (i) { want[i] -= Math.round(Math.max(0, want[i] - floorOf(i)) * k); });
    }
    var wide = need() > avail + 1;   // the last resort: the table scrolls
    if (nested && !wide) {   // a panel table spans its panel; the room beyond the columns' content is shared in proportion
      var total = 0; want.forEach(function (w, i) { if (!hidden[i]) total += w; });
      var scale = total > 0 && avail > total ? avail / total : 1;
      want = want.map(function (w) { return Math.floor(w * scale); });
      table.classList.add('ui-compact'); table.style.width = '';
    } else table.classList.remove('ui-compact');
    var anyHidden = hidden.some(function (h) { return h; });
    if (anyHidden && !table.querySelector('tr.ui-xrow')) autoXrows(table, true);   // the chevron inside the first cell: the columns stay
    if (!anyHidden && table.$autoXrows) autoXrows(table, false);
    table.$fitDebug = { avail: avail, want: want.slice(), hidden: hidden.slice(), flex: flex, wide: wide, widest: cols.map(function (c) { return Math.round(c.widest); }), kinds: cols.map(function (c) { return c.kind; }) };   // what the fit decided (the tests read it)
    // the <colgroup>: the visible columns only, in order (a hidden cell is display: none and drops out of its row, so a
    // <col> for it would hand its width to the next column)
    var cg = table.querySelector(':scope > colgroup.ui-fit-cols');
    if (!cg) { cg = doc.createElement('colgroup'); cg.className = 'ui-fit-cols'; table.insertBefore(cg, table.firstChild); }
    var shown = []; cols.forEach(function (c, i) { if (!hidden[i]) shown.push(i); });
    while (cg.children.length < shown.length) cg.appendChild(doc.createElement('col'));
    while (cg.children.length > shown.length) cg.removeChild(cg.lastChild);
    shown.forEach(function (i, k) { cg.children[k].style.width = (i === flex && !wide) ? '' : (i === flex ? Math.max(flexMin, Math.round(cols[i].widest) + FIT_PAD) : want[i]) + 'px'; });
    // a details panel spans exactly the visible columns: a colspan past the column count would add anonymous columns
    // and squeeze the others (the expanded row narrowed the command column)
    Array.prototype.forEach.call(table.querySelectorAll(':scope > tbody > tr.ui-xrow-panel > td, :scope > tbody > tr > td.ui-match-none'), function (td) { if (td.colSpan !== shown.length) td.colSpan = shown.length; });
    var KINDS = ['ui-col-flex', 'ui-col-wrap', 'ui-col-clamp', 'ui-col-num', 'ui-col-status', 'ui-col-narrow', 'ui-col-text', 'ui-col-wide', 'ui-col-icon'];
    Array.prototype.forEach.call(table.rows, function (r) {
      if (r.classList.contains('ui-xrow-panel')) return;
      Array.prototype.forEach.call(r.cells, function (cell, i) {
        if (i >= cols.length || cell.colSpan > 1) return;
        KINDS.forEach(function (k) { cell.classList.remove(k); });
        cell.classList.add(i === flex ? (cols[i].kind === 'wrap' ? 'ui-col-wrap' : cols[i].kind === 'clamp' ? 'ui-col-clamp' : 'ui-col-flex') : 'ui-col-' + cols[i].kind);
        cell.classList.toggle('ui-col-hidden', hidden[i]);
        if (cell.tagName === 'TD' && (cols[i].kind === 'text' || cols[i].kind === 'flex' || cols[i].kind === 'wide' || cols[i].kind === 'wrap' || cols[i].kind === 'narrow' || cols[i].kind === 'clamp')) breakable(cell);
        if (cell.tagName === 'TD' && (cols[i].kind === 'clamp' || cell.classList.contains('ui-cmd'))) clampCell(cell);
      });
    });
    table.classList.add('ui-fit');
    table.classList.toggle('ui-wide', wide);
    wrap.classList.toggle('ui-wide', wide);
    if (!(nested && !wide)) table.style.width = wide ? (need() - flexMin + (flex >= 0 ? Math.max(flexMin, cols[flex].widest + FIT_PAD) : 0)) + 'px' : '';
    noteHidden(table, wrap, cols, hidden);
    scrollHint(wrap, wide);
    titleTruncated(table);
  }
  // the hidden columns, named under the table (their values are in the row details)
  function noteHidden(table, wrap, cols, hidden) {
    var names = []; cols.forEach(function (c, i) { if (hidden[i]) names.push(table.tHead.querySelectorAll('th')[i].textContent.replace(/\s+/g, ' ').trim()); });
    var note = wrap.nextElementSibling && wrap.nextElementSibling.classList.contains('ui-table-note') ? wrap.nextElementSibling : null;
    if (!names.length) { if (note) note.remove(); return; }
    if (!note) { note = el('div', 'ui-table-note'); wrap.parentNode.insertBefore(note, wrap.nextSibling); }
    note.textContent = '';
    note.appendChild(doc.createTextNode('Hidden at this width: ' + names.join(', ') + ' - open a row (its chevron) for the values'));
    var menu = doc.querySelector('details.ui-menu#columns-menu, details.ui-menu[data-columns]');
    if (menu) { note.appendChild(doc.createTextNode('; ')); var b = el('button', 'ui-link', 'the Columns menu'); b.type = 'button'; b.addEventListener('click', function () { menu.open = true; try { menu.scrollIntoView({ block: 'nearest' }); } catch { /* older */ } }); note.appendChild(b); note.appendChild(doc.createTextNode(' shows any of them')); }
    else note.appendChild(doc.createTextNode('; a wider pane shows them'));
  }
  function scrollHint(wrap, wide) {
    var hint = wrap.querySelector(':scope > .ui-scroll-hint');
    if (!wide) { if (hint) hint.remove(); return; }
    if (!hint) { hint = el('div', 'ui-scroll-hint', 'scroll →'); hint.setAttribute('aria-hidden', 'true'); wrap.appendChild(hint); }
    hint.hidden = wrap.scrollLeft > 4;
  }
  // a cell cut by the ellipsis carries its whole value in the title (its own title, when the template set one, stays)
  function titleTruncated(table) {
    Array.prototype.forEach.call(table.querySelectorAll('td.ui-col-status, td.ui-col-num'), function (td) {
      if (td.$ownTitle === undefined) td.$ownTitle = td.hasAttribute('title');
      if (td.$ownTitle) return;
      if (td.scrollWidth > td.clientWidth + 1) td.setAttribute('title', td.textContent.replace(/\s+/g, ' ').trim()); else td.removeAttribute('title');
    });
  }
  // a break opportunity after / . _ : = in a text cell's identifiers (a path, an image, a namespace/name), so a
  // wrapped value breaks at a readable place; a text node only, never inside a chip or a control, once per cell
  var SEP = /([/._:=])(?=[^\s])/g;
  function breakable(td) {
    if (td.$wbr || td.querySelector('wbr')) return;
    td.$wbr = true;
    var walker = doc.createTreeWalker(td, NodeFilter.SHOW_TEXT, { acceptNode: function (n) { return n.parentElement && n.parentElement.closest('.ui-chip, .ui-badge, button, input, select, a, code, pre, .ui-meter') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
    var nodes = []; while (walker.nextNode()) { var t = walker.currentNode; if (t.nodeValue.length > 12 && SEP.test(t.nodeValue)) nodes.push(t); SEP.lastIndex = 0; }
    nodes.forEach(function (t) {
      var parts = t.nodeValue.split(SEP);   // [text, sep, text, sep, ...]
      if (parts.length < 3) return;
      var frag = doc.createDocumentFragment();
      for (var i = 0; i < parts.length; i++) { if (!parts[i]) continue; frag.appendChild(doc.createTextNode(parts[i])); if (i % 2 === 1 && i < parts.length - 1) frag.appendChild(doc.createElement('wbr')); }
      t.parentNode.replaceChild(frag, t);
    });
  }
  // a long-content cell: three lines, the whole value on a click (the row's details carry it too)
  function clampCell(td) {
    if (td.querySelector(':scope > .ui-clamp')) return;
    var span = el('span', 'ui-clamp'); while (td.firstChild) span.appendChild(td.firstChild); td.appendChild(span);
    span.addEventListener('click', function (e) { e.stopPropagation(); span.classList.toggle('ui-clamp-open'); });
  }
  // a code block for a row's details or a detail page (a command line, a unit file): full width in its box, wrapping,
  // the Copy button in its corner; codeBlock(text, label) -> the element
  var ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  // the copy icon button of a block: quiet, 26 px, its name the tooltip ("Copy command"); the shared data-copy
  // handler below swaps it to a check for a moment
  function copyButton(text, label) {
    var b = el('button', 'ui-icon-btn ui-code-copy'); b.type = 'button'; b.setAttribute('data-copy', text || ''); b.setAttribute('aria-label', label || 'Copy'); b.title = label || 'Copy'; b.innerHTML = ICON_COPY;
    return b;
  }
  function codeBlock(text, label) {
    var box = el('div', 'ui-code');
    var pre = el('pre', 'ui-code-text', text || '-');
    box.appendChild(copyButton(text, label || 'Copy')); box.appendChild(pre);
    return box;
  }
  // a template's <pre> with the data-code-copy attribute (the ui.code macro, or any pre marked so) gets the block
  function setupCodeBlocks(root) {
    Array.prototype.forEach.call((root || doc).querySelectorAll('pre[data-code-copy]'), function (pre) {
      if (pre.parentElement && pre.parentElement.classList.contains('ui-code')) return;
      var box = el('div', 'ui-code'); pre.parentNode.insertBefore(box, pre);
      box.appendChild(copyButton(pre.textContent, pre.getAttribute('data-code-copy') || 'Copy')); box.appendChild(pre); pre.classList.add('ui-code-text');
    });
  }
  // the hidden columns' values at the top of an opened row's details
  function hiddenIntoPanel(row) {
    var p = panelOf(row); if (!p) return;
    var body = p.querySelector('.ui-xrow-body'); if (!body) return;
    var old = body.querySelector(':scope > .ui-kv-hidden'); if (old) old.remove();
    var table = row.closest('table'); if (!table || !table.tHead) return;
    var ths = table.tHead.querySelectorAll('th');
    var items = [];
    Array.prototype.forEach.call(row.cells, function (cell, i) { if (cell.classList.contains('ui-col-hidden') && ths[i]) items.push([ths[i].textContent.replace(/\s+/g, ' ').trim(), cell]); });
    if (!items.length) return;
    var dl = el('dl', 'ui-kv ui-kv-hidden');
    items.forEach(function (it) { var d = el('div'); d.appendChild(el('dt', '', it[0])); var dd = el('dd'); dd.innerHTML = it[1].innerHTML; d.appendChild(dd); dl.appendChild(d); });
    var lead = body.firstElementChild && body.firstElementChild.classList.contains('ui-muted') && /hidden at this width/i.test(body.firstElementChild.textContent) ? body.firstElementChild : null;
    if (lead) body.insertBefore(dl, lead.nextSibling); else body.insertBefore(dl, body.firstChild);
  }
  var fitTimer = null;
  function fitAll(root) {
    Array.prototype.forEach.call((root || doc).querySelectorAll('table.ui-table'), function (t) { try { fitTable(t); } catch { /* a table mid-rebuild */ }
    });
    fitGrids();
  }
  function watchFit() {
    if (!window.ResizeObserver) return;
    var ro = new ResizeObserver(function () { if (fitTimer) return; fitTimer = setTimeout(function () { fitTimer = null; Array.prototype.forEach.call(doc.querySelectorAll('table.ui-table'), function (t) { t.$fitSig = null; }); fitAll(); }, 60); });
    ro.observe(doc.documentElement);
    var refit = function () { Array.prototype.forEach.call(doc.querySelectorAll('table.ui-table'), function (t) { t.$fitSig = null; }); fitAll(); };
    if (doc.fonts) { try { doc.fonts.ready.then(refit); doc.fonts.addEventListener("loadingdone", refit); } catch { /* no FontFaceSet */ } }
    doc.addEventListener('scroll', function (e) { var w = e.target && e.target.classList && e.target.classList.contains('ui-table-wrap') ? e.target : null; if (w && w.classList.contains('ui-wide')) scrollHint(w, true); }, true);
  }
  /* ---- the page stack: the content root and the templates' plain wrapper divs carry .ui-stack, so the page's
     top-level blocks keep one gap (--ui-stack-gap) between them wherever the template put them ---- */
  function isWrapper(el) {
    if (!el || el.tagName !== 'DIV' || el.classList.contains('panel') || el.hasAttribute('data-chart-card')) return false;
    if (/\b(ui-[a-z-]+|au-|lc-|bl-|kd-)/.test(el.className || '') && !/\bspace-y-/.test(el.className || '')) return false;
    return Array.prototype.some.call(el.children, function (c) { return c.classList && (c.classList.contains('panel') || c.classList.contains('ui-findings') || c.classList.contains('ui-grid-charts') || c.tagName === 'SECTION' || c.classList.contains('ui-detail')); }) || /\bspace-y-/.test(el.className || '');
  }
  // the chart grid: the last card, alone in its row, spans the row (no lone half-width card); read from the layout
  function fitGrids() {
    Array.prototype.forEach.call(doc.querySelectorAll('#diagnostics-content .ui-grid-charts'), function (g) {
      var cards = Array.prototype.filter.call(g.children, function (c) { return c.getBoundingClientRect().height > 0 && !c.hasAttribute('data-wide'); });
      cards.forEach(function (c) { c.removeAttribute('data-span'); });
      if (cards.length < 2) return;
      var tops = {}; cards.forEach(function (c) { var t = Math.round(c.getBoundingClientRect().top); tops[t] = (tops[t] || 0) + 1; });
      var perRow = Math.max.apply(null, Object.keys(tops).map(function (k) { return tops[k]; }));
      var last = cards[cards.length - 1];
      if (perRow > 1 && tops[Math.round(last.getBoundingClientRect().top)] === 1) last.setAttribute('data-span', '');
    });
  }
  function stackPage() {
    var root = doc.getElementById('diagnostics-content'); if (!root) return;
    root.classList.add('ui-stack');
    Array.prototype.forEach.call(root.querySelectorAll('div'), function (d) { if (d.closest('table, .panel, .ui-findings, .ui-detail-section') && !/\bspace-y-/.test(d.className || '')) return; if (isWrapper(d)) d.classList.add('ui-stack'); });
  }
  /* ---- a table whose columns hide at this width: every row gets the shared chevron, its details show the hidden
     values (hiddenIntoPanel); taken away again when nothing is hidden ---- */
  function autoXrows(table, on) {
    var body = table.tBodies[0]; if (!body) return;
    if (on) {
      if (table.querySelector('tr.ui-xrow:not(.ui-xrow-auto)')) return;   // the page's own expandable rows carry the values already
      table.$autoXrows = true; table.setAttribute('data-auto-xrows', '');
      Array.prototype.slice.call(body.rows).forEach(function (r) {
        if (r.classList.contains('ui-xrow-panel') || r.classList.contains('ui-xrow-auto') || !r.cells[0] || r.cells[0].colSpan > 1) return;
        r.classList.add('ui-xrow', 'ui-xrow-auto'); r.$xrow = true;
        if (!r.hasAttribute('tabindex')) r.setAttribute('tabindex', '0');
        r.setAttribute('aria-expanded', 'false');
        var b = xrowButton(); b.classList.add('ui-xrow-inline'); r.cells[0].insertBefore(b, r.cells[0].firstChild);   // inside the first cell: the page's column indexes stay
      });
    } else if (table.$autoXrows) {
      table.$autoXrows = false; table.removeAttribute('data-auto-xrows');
      Array.prototype.slice.call(body.querySelectorAll('tr.ui-xrow-panel')).forEach(function (p) { if (p.previousElementSibling && p.previousElementSibling.classList.contains('ui-xrow-auto')) p.remove(); });
      Array.prototype.slice.call(body.querySelectorAll('tr.ui-xrow-auto')).forEach(function (r) { r.classList.remove('ui-xrow', 'ui-xrow-auto', 'ui-open'); r.removeAttribute('aria-expanded'); r.$xrow = false; var b = r.querySelector('.ui-xrow-inline'); if (b) b.remove(); });
    }
    // a panel left behind by the page's own re-render (its row sorted away): gone
    Array.prototype.slice.call(body.querySelectorAll('tr.ui-xrow-panel')).forEach(function (p) { var prev = p.previousElementSibling; if (!prev || !prev.classList.contains('ui-xrow')) p.remove(); });
  }
  function setupTables(root) {
    stackPage();
    setupCodeBlocks(root);
    var tables = Array.prototype.slice.call((root || doc).querySelectorAll('table'));
    tables.forEach(function (t) { if (t.closest('.au-diff, .lc-table-wrap') || t.classList.contains('lc-table') || t.classList.contains('au-diff')) return; if (!t.classList.contains('ui-table')) t.classList.add('ui-table'); wrapTable(t); labelCells(t); });
    setupXrows(root); defaultSort(root);
    fitAll(root);
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
    if (!p && row.classList.contains('ui-xrow-auto')) {   // the auto row: its panel is made on open
      if (open === false) return;
      var table = row.closest('table'); var shown = table ? Array.prototype.filter.call(table.tHead ? table.tHead.querySelectorAll('th') : [], function (th) { return !th.classList.contains('ui-col-hidden'); }).length : 1;
      p = xrowPanel(Math.max(1, shown), el('div', 'ui-muted', 'The columns hidden at this width:'));
      row.parentNode.insertBefore(p, row.nextSibling);
    }
    if (!p) return;
    if (open === undefined) open = p.hidden;
    p.hidden = !open;
    row.classList.toggle('ui-open', open);
    row.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) hiddenIntoPanel(row);
    var b = row.querySelector('.ui-xrow-btn'); if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
    try { window.dispatchEvent(new Event('resize')); } catch { /* an old frame */ }
  }
  function setupXrows(root) {
    Array.prototype.forEach.call((root || doc).querySelectorAll('tr.ui-xrow'), function (row) {
      if (row.$xrow || row.classList.contains('ui-xrow-auto')) return;
      row.$xrow = true;
      if (!row.querySelector('.ui-xrow-cell')) row.insertBefore(xrowCell(), row.firstChild);
      if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex', '0');
      if (!row.hasAttribute('aria-expanded')) row.setAttribute('aria-expanded', 'false');
      var p = panelOf(row); if (p && !p.hidden && !row.classList.contains('ui-open')) p.hidden = true;
    });
    Array.prototype.forEach.call((root || doc).querySelectorAll('table'), function (t) {
      if (t.$xrowHead || !t.querySelector('tr.ui-xrow:not(.ui-xrow-auto)')) return;
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
      var text = copy.getAttribute('data-copy'); if (!text) { var src = copy.previousElementSibling || copy.nextElementSibling; text = src ? src.textContent : ''; }
      writeClipboard(text);
      copied(copy);
      return;
    }
    var row = t.closest ? t.closest('tr.ui-xrow') : null;
    if (!row) return;
    if (t.closest('a, input, select, textarea, label, details, button:not(.ui-xrow-btn)')) return;
    setOpen(row);
  });
  // the clipboard in the sandboxed frame: the async API where it is allowed, execCommand on a scratch textarea else
  function writeClipboard(text) {
    var ok = false;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).catch(function () { execCopy(text); }); ok = true; } } catch { ok = false; }
    if (!ok) execCopy(text);
  }
  function execCopy(text) {
    try { var ta = el('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position: fixed; left: -9999px; top: 0'; doc.body.appendChild(ta); ta.select(); doc.execCommand('copy'); ta.remove(); } catch { /* no clipboard at all */ }
  }
  // the copied state: an icon button shows the check, a text button says Copied; aria-live tells it; back after 1.5 s
  var liveNote = null;
  function copied(button) {
    if (!liveNote) { liveNote = el('div', 'ui-sr'); liveNote.setAttribute('aria-live', 'polite'); doc.body.appendChild(liveNote); }
    liveNote.textContent = 'Copied';
    button.classList.add('ui-copied');
    var icon = button.classList.contains('ui-icon-btn');
    var was = icon ? button.innerHTML : button.textContent;
    if (icon) button.innerHTML = ICON_CHECK; else button.textContent = 'Copied';
    var title = button.title; if (icon) button.title = 'Copied';
    setTimeout(function () { button.classList.remove('ui-copied'); if (icon) { button.innerHTML = was; button.title = title; } else button.textContent = was; liveNote.textContent = ''; }, 1500);
  }
  doc.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var t = e.target;
    if (!t.classList || !t.classList.contains('ui-xrow')) return;
    e.preventDefault();
    setOpen(t);
  });
  window.diagTables = { setup: setupTables, label: labelCells, wrap: wrapTable, markSort: markSort, defaultSort: defaultSort, xrows: setupXrows, open: setOpen, xrowCell: xrowCell, xrowPanel: xrowPanel, fit: fitTable, fitAll: fitAll, breakable: breakable, codeBlock: codeBlock, copyButton: copyButton };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { setupTables(); watchTables(); watchFit(); });
  else { setupTables(); watchTables(); watchFit(); }

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
    // A click on a chart (config.onPick(pick)): the clicked element through Chart.js's own hit test - intersect:
    // true on the orientation's index axis (a horizontal bar resolves along y, a vertical one along x; the
    // 'index' mode on the wrong axis handed a neighbouring row to the filter). pick = { index, label, key, value,
    // datasetLabel, row }: label is what the chart shows (a node's short name, a process's name + pid), key the
    // exact filter value stored beside it (data.keys[i], a row's key, else the label); a category marked other
    // (data.others[i], a row's other) is not clickable. The pointer shows only over a clickable element.
    if (config.onPick) {
      var onPick = config.onPick;
      var pickAt = function (evt, c) {
        var horizontal = c.options.indexAxis === 'y';
        var pts = c.getElementsAtEventForMode(evt, 'nearest', { intersect: true, axis: horizontal ? 'y' : 'x' }, false);
        if (!pts.length) return null;
        var i = pts[0].index, ds = c.data.datasets[pts[0].datasetIndex] || {};
        var keys = c.data.keys || [], others = c.data.others || [];
        var row = c.$diagRows ? c.$diagRows[i] : null;
        if (others[i] || (row && row.other)) return null;
        var raw = ds.data ? ds.data[i] : undefined;
        var value = raw && typeof raw === 'object' ? (raw.y !== undefined ? raw.y : raw.x) : raw;
        var label = c.data.labels ? c.data.labels[i] : (raw && raw.label);
        var key = keys[i] !== undefined ? keys[i] : (row && row.key !== undefined ? row.key : label);
        return { index: i, label: label, key: key, value: value, datasetLabel: ds.$label || ds.label || '', row: row, raw: raw };
      };
      // the page's handler runs after Chart.js is done with the click: a handler that re-draws or re-creates the chart
      // (a filter change) would otherwise run inside the chart's own event dispatch, on a chart it just destroyed
      config.options.onClick = function (evt, items, c) { var p = pickAt(evt, c); c.canvas.$lastPick = p; if (p) setTimeout(function () { onPick(p, c); }, 0); };
      config.options.onHover = function (evt, items, c) { var p = pickAt(evt, c); c.canvas.style.cursor = p ? 'pointer' : ''; };
    }
    config.plugins = (config.plugins || []).concat([emptyPlugin, rotatePlugin, valueLabelsPlugin]);
    config.options = config.options || {}; config.options.plugins = config.options.plugins || {};
    config.options.plugins.diagValueLabels = { on: !!config.valueLabels };   // read by the plugin on every draw, the first one included
    var type = config.type || 'bar';
    var radial = /^(doughnut|pie|polarArea|radar)$/.test(type);
    var horizontal = config.options && config.options.indexAxis === 'y';
    setEmpty(canvas, !hasData(config));
    config.options = config.options || {};
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
      onPick: onBucket ? function (p) { var pt = p.raw && p.raw.bucket ? p.raw : null; if (pt) onBucket(pt.bucket); } : null,
      options: { interaction: { mode: 'index', intersect: false },
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
      onPick: onRow ? function (p) { onRow(rows[p.index], p); } : null,
      data: { labels: rows.map(function (r) { return r.name; }), keys: rows.map(function (r) { return r.key !== undefined ? r.key : r.name; }), others: rows.map(function (r) { return !!r.other; }), datasets: datasets },
      options: { indexAxis: 'y',
        layout: capOf ? { padding: { right: 72 } } : {},
        plugins: { legend: { display: !!(opts.legend || stacks), position: 'bottom' }, tooltip: { mode: 'index', callbacks: {
          title: function (items) { var r = rows[items[0].dataIndex] || {}; return r.title || r.name; },
          label: function (item) { if (stacks && !item.raw) return null; var r = rows[item.dataIndex] || {}; var lab = item.dataset.$label || item.dataset.label; return (lab ? lab + ': ' : '') + format(item.raw, r); },
          afterBody: function (items) { var r = rows[items[0].dataIndex] || {}; var lines = opts.tooltip ? (opts.tooltip(r) || []) : []; if (capOf && capOf(r)) lines = lines.concat(['capacity ' + fmt.num(capOf(r)) + ' pods (' + Math.round(100 * (r.count || 0) / capOf(r)) + '%)']); if (onRow) lines = lines.concat(['click: filter to this']); return lines; } } } },
        scales: { x: { stacked: stacked, beginAtZero: true, ticks: { font: { size: 10 }, maxTicksLimit: 5, precision: 0, callback: function (v) { return format(v); } } },
          // the category axis: as wide as its longest label up to 40% of the chart; a longer label is cut with an ellipsis
          // (its whole name is the tooltip's title), so no label ever loses its first letters at the canvas edge
          y: { stacked: stacked, grid: { display: false }, afterFit: function (s) { var cap = Math.round((s.chart.width || 600) * 0.4); if (s.width > cap) s.width = cap; },
            ticks: { font: { size: 10.5, family: mono() }, callback: function (v) { var label = String(this.getLabelForValue(v)); var cap = Math.max(6, Math.floor(((this.chart.width || 600) * 0.4 - 16) / 6.5)); return label.length > cap ? label.slice(0, cap - 1) + '\u2026' : label; } } } } },
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
    // a detail page's key ("detail=<ns>/<name>") goes to diagDetail, a Log Viewer's source list ("sources=...") to
    // diagLogView, every other query to the page's search field
    if (window.diagDetail && window.diagDetail.applyQuery(q)) return true;
    if (window.diagLogView && window.diagLogView.applyQuery && window.diagLogView.applyQuery(q)) return true;
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

/*
  diagDetail: the one list -> detail transition of the Diagnostics pages (the must-gather Pod, Node, Deployment ...
  details). A page with a list and a detail view registers them once:

    const list = document.getElementById('podListPanel');     // the list (its charts, filters, table, pager)
    const view = document.getElementById('podDetail');        // {{ ui.detail_page('podDetail') }}
    window.diagDetail.register(list, view, {
      rows: 'tbody tr[data-detail]',                // the rows that open a detail (data-detail = the key)
      keys: () => visibleKeys(),                    // optional: the keys in the list's current order (Previous / Next)
      render: (key, view) => {                      // fills the view for one key; false when the key is unknown
        const pod = byKey[key]; if (!pod) return false;
        window.diagDetail.header(view, { title: pod.name, crumbs: ['Pods', pod.namespace, pod.name], badge: { kind: 'bad', text: 'CrashLoopBackOff' },
          actions: [{ label: 'Copy name', copy: pod.name }, { label: 'Open events', tab: 'system', subTab: 'events', query: pod.name }] });
        window.diagDetail.findings(view, pod._detail.findings);
        const body = window.diagDetail.body(view);   // emptied; the page appends its sections
        body.appendChild(window.diagDetail.section('Containers', cards, { open: true }));
        return true;
      },
    });

  What the controller does on its own: a click on a row (or Enter / Space on the focused row, or the cross-link
  query "detail=<key>" another page sends) opens the key; the list stays in the DOM, hidden (its filters, sort,
  page and expanded rows untouched), the view fades in (none of it under prefers-reduced-motion), the title takes
  the focus, the pane scrolls to the view's top. Back (the bar's button, Escape, Alt+ArrowLeft, the mouse's back
  button) shows the list again at the scroll position it had, the opened row highlighted and focused. Previous /
  Next walk the list's current order.

  The pieces of a detail page, built here so every page looks the same: header (the bar: Back, the breadcrumb, the
  status badge, the quick actions, Previous / Next; the title), findings (the object's own Findings strip), body,
  section (a card with a title, open or folded), kv (the key / value grid), cards (one card per container ...),
  table, badge, chip, meter, link (a cross-link to another page), masked (a secret-ish value with Reveal), when
  (a timestamp without its T and Z). Nothing here is page-specific.
*/
(function () {
  var doc = document;
  var views = [];
  var MOTION_MS = 160;
  function reduced() { try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } }
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; }
  function viewportTop() { return window.diagnosticsViewport ? window.diagnosticsViewport.top : (window.scrollY || 0); }
  function scrollTo(y) { y = Math.max(0, Math.round(y)); if (window.diagnosticsScrollTo) window.diagnosticsScrollTo(y); else window.scrollTo(0, y); }
  // the pane's scroll after a height change: the frame reports its new height a moment later, so the scroll is
  // asked for again until the view sits where it was asked to (or three tries pass)
  function settle(y) { scrollTo(y); [120, 360].forEach(function (ms) { setTimeout(function () { if (Math.abs(viewportTop() - y) > 2) scrollTo(y); }, ms); }); }
  function heightChanged() { try { window.dispatchEvent(new Event('resize')); } catch { /* an old frame */ } }

  function Registration(list, view, opts) {
    this.list = list; this.view = view; this.opts = opts || {};
    this.rowsSelector = this.opts.rows || 'tbody tr[data-detail]';
    this.key = null; this.row = null; this.savedTop = 0; this.covered = null;
    var self = this;
    list.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest && t.closest('a, input, select, textarea, label, button, details, summary, .ui-xrow-btn, [data-copy], [data-tab]')) return;
      var row = t.closest ? t.closest(self.rowsSelector) : null;
      if (!row || !list.contains(row)) return;
      self.open(row.getAttribute('data-detail'), row);
    });
    list.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var row = e.target && e.target.closest ? e.target.closest(self.rowsSelector) : null;
      if (!row || e.target !== row) return;
      e.preventDefault();
      self.open(row.getAttribute('data-detail'), row);
    });
    var back = view.querySelector('[data-detail-back]');
    if (back) back.addEventListener('click', function () { self.back(); });
    var prev = view.querySelector('[data-detail-prev]'), next = view.querySelector('[data-detail-next]');
    if (prev) prev.addEventListener('click', function () { self.step(-1); });
    if (next) next.addEventListener('click', function () { self.step(1); });
  }
  Registration.prototype.rowOf = function (key) {
    var rows = this.list.querySelectorAll(this.rowsSelector);
    for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute('data-detail') === key) return rows[i];
    return null;
  };
  Registration.prototype.keys = function () {
    if (this.opts.keys) return this.opts.keys();
    return Array.prototype.map.call(this.list.querySelectorAll(this.rowsSelector), function (r) { return r.getAttribute('data-detail'); });
  };
  Registration.prototype.open = function (key, row) {
    if (!key) return false;
    var ok = this.opts.render ? this.opts.render(key, this.view) : true;
    if (ok === false) return false;
    var wasOpen = !this.view.hidden;
    if (!wasOpen) {
      this.savedTop = viewportTop(); this.row = row || this.rowOf(key);
      // the whole page gives way to the detail: the list and everything beside it (the page's own Findings strip)
      var v = this.view;
      this.covered = Array.prototype.filter.call(v.parentElement ? v.parentElement.children : [], function (c) { return c !== v && !c.hidden && !/^(SCRIPT|STYLE|TEMPLATE)$/.test(c.tagName); });
      this.covered.forEach(function (c) { c.hidden = true; c.setAttribute('aria-hidden', 'true'); });
    }
    this.key = key;
    this.view.hidden = false;
    this.view.removeAttribute('aria-hidden');
    if (!reduced() && !wasOpen) { this.view.classList.add('ui-detail-in'); var v1 = this.view; setTimeout(function () { v1.classList.remove('ui-detail-in'); }, MOTION_MS + 40); }
    this.position();
    var title = this.view.querySelector('.ui-detail-title');
    var v2 = this.view;
    heightChanged();
    setTimeout(function () { settle(v2.getBoundingClientRect().top + (window.scrollY || 0) - 8); if (title) { try { title.focus({ preventScroll: true }); } catch { title.focus(); } } }, 0);
    return true;
  };
  Registration.prototype.back = function () {
    if (this.view.hidden) return;
    this.view.hidden = true;
    this.view.setAttribute('aria-hidden', 'true');
    (this.covered || [this.list]).forEach(function (c) { c.hidden = false; c.removeAttribute('aria-hidden'); });
    this.covered = null;
    var row = (this.row && this.row.isConnected) ? this.row : this.rowOf(this.key);
    var top = this.savedTop;
    heightChanged();
    setTimeout(function () {
      settle(top);
      if (row) {
        row.classList.add('ui-row-hl');
        if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex', '-1');
        try { row.focus({ preventScroll: true }); } catch { /* older frame */ }
        setTimeout(function () { row.classList.remove('ui-row-hl'); }, 1600);
      }
    }, 0);
    this.key = null; this.row = null;
  };
  Registration.prototype.position = function () {
    var keys = this.keys(), i = keys.indexOf(this.key);
    var prev = this.view.querySelector('[data-detail-prev]'), next = this.view.querySelector('[data-detail-next]'), pos = this.view.querySelector('.ui-detail-pos');
    if (prev) prev.disabled = i <= 0;
    if (next) next.disabled = i < 0 || i >= keys.length - 1;
    if (pos) pos.textContent = i >= 0 ? (i + 1) + ' of ' + keys.length : '';
  };
  Registration.prototype.step = function (d) {
    var keys = this.keys(), i = keys.indexOf(this.key) + d;
    if (i < 0 || i >= keys.length) return;
    this.open(keys[i], this.rowOf(keys[i]) || this.row);
  };

  function register(list, view, opts) {
    var r = new Registration(list, view, opts);
    views.push(r);
    return r;
  }
  function current() { for (var i = 0; i < views.length; i++) if (!views[i].view.hidden) return views[i]; return null; }
  function openKey(key) { for (var i = 0; i < views.length; i++) if (views[i].open(key)) return true; return false; }

  // ---- the shared pieces of a detail page ----
  function badge(kind, text, title) { var b = el('span', 'ui-badge ui-badge-' + (kind || 'muted'), text); if (title) b.title = title; return b; }
  function chip(text, title) { var c = el('span', 'ui-chip ui-chip-static', text); if (title) c.title = title; return c; }
  function meter(value, max, role, text, title) {
    var pct = max ? 100 * (value || 0) / max : 0; pct = Math.max(0, Math.min(100, pct));
    var m = el('span', 'ui-meter'); m.setAttribute('data-role', role || 'ok'); m.setAttribute('role', 'meter'); m.setAttribute('aria-valuenow', String(value || 0)); m.setAttribute('aria-valuemin', '0'); m.setAttribute('aria-valuemax', String(max || 100)); if (title) m.title = title;
    var track = el('span', 'ui-meter-track'); var fill = el('span', 'ui-meter-fill'); fill.style.width = pct.toFixed(1) + '%'; track.appendChild(fill); m.appendChild(track);
    m.appendChild(el('span', 'ui-meter-value', text !== undefined && text !== null ? text : Math.round(pct) + '%'));
    return m;
  }
  function when(iso) { return iso ? String(iso).replace('T', ' ').replace(/(\.\d+)?Z$/, '') : ''; }
  function header(view, h) {
    h = h || {};
    var title = view.querySelector('.ui-detail-title'); if (title) title.textContent = h.title || '';
    var crumbs = view.querySelector('.ui-detail-crumbs');
    if (crumbs) {
      crumbs.textContent = '';
      (h.crumbs || []).forEach(function (c, i, all) {
        if (i) crumbs.appendChild(el('span', 'ui-detail-sep', '/'));
        var s = el('span', i === all.length - 1 ? 'ui-detail-crumb ui-detail-here' : 'ui-detail-crumb', c);
        if (i === all.length - 1) s.setAttribute('aria-current', 'page');
        crumbs.appendChild(s);
      });
    }
    var slot = view.querySelector('.ui-detail-badge');
    if (slot) { slot.textContent = ''; if (h.badge && h.badge.text) slot.appendChild(badge(h.badge.kind, h.badge.text, h.badge.title)); }
    var actions = view.querySelector('.ui-detail-actions');
    if (actions) {
      actions.textContent = '';
      (h.actions || []).forEach(function (a) {
        var b = el('button', 'btn btn-secondary btn-sm', a.label); b.type = 'button';
        if (a.copy !== undefined) b.setAttribute('data-copy', a.copy);
        if (a.tab) { b.setAttribute('data-tab', a.tab); if (a.subTab) b.setAttribute('data-sub-tab', a.subTab); if (a.query) b.setAttribute('data-query', a.query); }
        if (a.onClick) b.addEventListener('click', a.onClick);
        if (a.title) b.title = a.title;
        actions.appendChild(b);
      });
    }
  }
  // the object's own Findings strip (the same markup as the page's, tabs/_ui.html findings())
  function findings(view, items, titleText) {
    var slot = view.querySelector('.ui-detail-findings'); if (!slot) return;
    slot.textContent = '';
    items = (items || []).slice();
    if (!items.length) return;
    var sec = el('section', 'ui-findings'); sec.setAttribute('aria-label', titleText || 'Findings');
    var head = el('div', 'ui-findings-head', (titleText || 'Findings') + ' '); head.appendChild(el('span', 'ui-count-text', items.length)); sec.appendChild(head);
    var ul = el('ul', 'ui-findings-list');
    items.forEach(function (f) {
      var li = el('li', 'ui-finding ui-finding-' + (f.severity || 'info'));
      li.appendChild(badge(f.badge || f.severity || 'info', String(f.severity || 'info').toUpperCase()));
      var body = el('div', 'ui-finding-body'); body.appendChild(el('span', 'ui-finding-title', f.title)); if (f.detail) body.appendChild(el('span', 'ui-finding-detail', f.detail)); li.appendChild(body);
      if (f.link && f.link.tab) { var b = el('button', 'ui-link ui-finding-link', 'Open'); b.type = 'button'; b.setAttribute('data-tab', f.link.tab); b.setAttribute('data-sub-tab', f.link.sub_tab || ''); b.setAttribute('data-query', f.link.query || ''); li.appendChild(b); }
      ul.appendChild(li);
    });
    sec.appendChild(ul); slot.appendChild(sec);
  }
  function body(view) { var b = view.querySelector('.ui-detail-body'); if (b) b.textContent = ''; return b; }
  // a section of the detail: a card with a title, open or folded (details.ui-details); content: a node, a string or nothing
  function section(title, content, opts) {
    opts = opts || {};
    var d = el('details', 'panel rounded-lg shadow-sm ui-details ui-detail-section' + (opts.extra ? ' ' + opts.extra : '')); if (opts.open) d.open = true;
    var s = el('summary'); var t = el('span', 'ui-card-title'); t.appendChild(el('span', '', title)); if (opts.count !== undefined && opts.count !== null) { t.appendChild(doc.createTextNode(' ')); t.appendChild(el('span', 'ui-count-text', opts.count)); } s.appendChild(t); d.appendChild(s);
    var b = el('div', 'ui-detail-section-body'); if (typeof content === 'string') b.appendChild(el('p', 'ui-muted', content)); else if (content) b.appendChild(content); d.appendChild(b);
    if (opts.onOpen) d.addEventListener('toggle', function () { if (d.open) opts.onOpen(b); });
    return d;
  }
  // the key / value grid: items = [[label, value], [label, node], [label, value, 'mono']]; empty values are skipped
  function kv(items) {
    var dl = el('dl', 'ui-kv');
    (items || []).forEach(function (it) {
      var v = it[1];
      if (v === undefined || v === null || v === '' || v === '-') return;
      var d = el('div'); d.appendChild(el('dt', '', it[0]));
      var dd = el('dd', it[2] ? 'ui-' + it[2] : '');
      if (v instanceof Node) dd.appendChild(v); else dd.textContent = String(v);
      d.appendChild(dd); dl.appendChild(d);
    });
    return dl;
  }
  // a grid of cards (one per container ...): items = [{ title, badges: [node], body: node }]
  function cards(items) {
    var grid = el('div', 'ui-detail-cards');
    (items || []).forEach(function (c) {
      var card = el('div', 'ui-detail-card');
      var head = el('div', 'ui-detail-card-head'); head.appendChild(el('span', 'ui-detail-card-title', c.title)); (c.badges || []).forEach(function (b) { head.appendChild(b); }); card.appendChild(head);
      if (c.body) card.appendChild(c.body);
      grid.appendChild(card);
    });
    return grid;
  }
  // a cross-link inside a value (data-tab: diagLinks opens the tab with the query)
  function link(text, tab, subTab, query, title) { var b = el('button', 'ui-link', text); b.type = 'button'; b.setAttribute('data-tab', tab); if (subTab) b.setAttribute('data-sub-tab', subTab); if (query) b.setAttribute('data-query', query); if (title) b.title = title; return b; }
  // a small table: head = ['A', { text: 'B', w: 'num' }], rows = [[a, b], ...] (strings or nodes; a row may be { cells, cls })
  function table(head, rows, opts) {
    var wrap = el('div', 'ui-table-wrap'); var t = el('table', 'ui-table'); var thead = el('thead'); var tr = el('tr');
    head.forEach(function (h) { var th = el('th', '', typeof h === 'string' ? h : h.text); if (h && h.w) th.setAttribute('data-w', h.w); if (h && h.p) th.setAttribute('data-p', h.p); tr.appendChild(th); });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = el('tbody');
    rows.forEach(function (r) { var row = el('tr'); if (r.cls) row.className = r.cls; (r.cells || r).forEach(function (c) { var td = el('td'); if (c instanceof Node) td.appendChild(c); else td.textContent = c === undefined || c === null ? '' : String(c); row.appendChild(td); }); tb.appendChild(row); });
    t.appendChild(tb); wrap.appendChild(t);
    if (opts && opts.id) t.id = opts.id;
    return wrap;
  }
  // a value that may be a secret: masked, with Reveal
  var SECRETISH = /(password|passwd|secret|token|credential|private|cert|cookie|auth|api[-_]?key|access[-_]?key)/i;
  function masked(value) {
    var s = el('span', 'ui-masked'); var dots = el('span', 'ui-masked-dots', '••••••'); var real = el('span', 'ui-masked-value', value); real.hidden = true;
    var b = el('button', 'ui-link ui-masked-toggle', 'Reveal'); b.type = 'button';
    b.addEventListener('click', function () { var show = real.hidden; real.hidden = !show; dots.hidden = show; b.textContent = show ? 'Hide' : 'Reveal'; });
    s.appendChild(dots); s.appendChild(real); s.appendChild(b);
    return s;
  }
  function list(items) { var ul = el('ul', 'ui-detail-list'); (items || []).forEach(function (it) { var li = el('li'); if (it instanceof Node) li.appendChild(it); else li.textContent = String(it); ul.appendChild(li); }); return ul; }

  doc.addEventListener('keydown', function (e) {
    var r = current(); if (!r) return;
    if (e.key === 'Escape' || (e.key === 'ArrowLeft' && e.altKey)) {
      // Escape in a field with text clears the field first (the YAML search); the second press goes back
      if (e.key === 'Escape' && e.target && e.target.closest && e.target.closest('input, textarea, select') && e.target.value) return;
      e.preventDefault(); r.back();
    }
  });
  doc.addEventListener('mouseup', function (e) { if (e.button === 3) { var r = current(); if (r) { e.preventDefault(); r.back(); } } });
  // the cross-link query "detail=<key>": open that detail (diagLinks hands every query here first; the list may
  // still be rendering, so the key is tried again for two seconds)
  function applyQuery(q) { var m = /^detail=(.+)$/.exec(String(q || '')); if (!m) return false; var key = m[1]; var tries = 0; (function go() { if (openKey(key) || tries++ > 20) return; setTimeout(go, 100); })(); return true; }

  window.diagDetail = { register: register, open: openKey, back: function () { var r = current(); if (r) r.back(); }, current: current, header: header, findings: findings, body: body, section: section, kv: kv, cards: cards, link: link, table: table, badge: badge, chip: chip, meter: meter, list: list, masked: masked, when: when, secretish: function (name) { return SECRETISH.test(String(name || '')); }, applyQuery: applyQuery, el: el };
})();

/*
  diagCode: the code viewer of a detail page. diagCode.render(host, object, opts) shows the object as JSON (the text
  JSON.stringify writes with two-space indents: one source of truth, what is shown, searched and copied is the same
  text) or, on the toolbar's toggle, as YAML (js-yaml's dump of the same object). The text is highlighted as one
  document by highlight.js (its json / yaml languages) and then cut into lines, so a token that spans lines keeps
  its class on every line and nothing between the lines is lost - the gap the old per-line regex highlighter left
  after numbers is gone with it. Line numbers; a sticky toolbar with a search (every match marked, Next / Previous
  and "n of m"; "Filter lines" keeps only the matching lines); fold / unfold on every key that opens a block
  (metadata.managedFields folded from the start); a wrap toggle; Copy (the format on show); a copy of a key's path
  (click the key); and the values under secret-ish keys (and the data of a Secret) masked with Reveal (one value,
  or all of them from the toolbar).
  opts: { format: 'json' | 'yaml', fold: ['metadata.managedFields'], mask: true, kind: 'Secret', yaml: true }
  Returns { search(q), text(), format(), state }. js-yaml comes inlined into the frame
  (src/components/DiagnosticsPage.jsx); the highlighting is the app's own highlight.js, asked through the frame's
  "/highlight" message (one entry point, src/utils/codeHighlight.js); the standalone dashboard loads both as vendored
  files (backend/templates/layout.html, scripts/vendor-assets.mjs). Without them the viewer shows the plain text.
*/
(function () {
  var doc = document;
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; }
  var SECRETISH = /(password|passwd|secret|token|credential|private|cookie|auth|api[-_]?key|access[-_]?key)/i;
  var SENTINEL = /^"?MASKED_VALUE_(\d+)"?,?$/;
  var DOTS = '••••••';
  // the object with its secret-ish scalars replaced by sentinels (originals[n] keeps each value for Reveal) and
  // the parsers' own top-level keys (_detail, _age_seconds) left out
  function prepare(obj, opts, originals, path, underData) {
    if (Array.isArray(obj)) return obj.map(function (v, i) { return prepare(v, opts, originals, path + '[' + i + ']', underData); });
    if (obj && typeof obj === 'object') {
      var out = {};
      Object.keys(obj).forEach(function (k) {
        if (!path && k.charAt(0) === '_') return;
        var v = obj[k];
        var dataOfSecret = opts.kind === 'Secret' && !path && (k === 'data' || k === 'stringData');
        var secret = opts.mask !== false && (SECRETISH.test(k) || underData);
        if (secret && v !== null && v !== undefined && typeof v !== 'object' && String(v) !== '') { originals.push(v); out[k] = 'MASKED_VALUE_' + (originals.length - 1); }
        else out[k] = prepare(v, opts, originals, path ? path + '.' + k : k, underData || dataOfSecret);
      });
      return out;
    }
    return obj;
  }
  function textOf(obj, format) {
    if (format === 'yaml' && window.jsyaml && window.jsyaml.dump) { try { return window.jsyaml.dump(obj, { lineWidth: -1, noRefs: true, noCompatMode: true, sortKeys: false }); } catch { /* json then */ } }
    return JSON.stringify(obj, null, 2) + '\n';
  }
  function escapeText(text) { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  // the syntax colours: the standalone dashboard's own highlighter (window.hljs, vendored), else the app around the
  // frame (the "/highlight" message, answered by src/utils/codeHighlight.js), else the plain text; always a promise
  function highlight(text, format) {
    if (window.hljs && window.hljs.highlight) { try { return Promise.resolve(window.hljs.highlight(text, { language: format, ignoreIllegals: true }).value); } catch { /* plain */ } }
    if (window.diagnosticsApiRequest) {
      return window.diagnosticsApiRequest('/highlight', { text: text, language: format })
        .then(function (r) { return r && r.ok && r.json && typeof r.json.html === 'string' ? r.json.html : escapeText(text); })
        .catch(function () { return escapeText(text); });
    }
    return Promise.resolve(escapeText(text));
  }
  // the highlighted document cut into lines: a text node is split at its newlines, each piece lands inside a
  // copy of the span chain it came from, so a multi-line token keeps its class on every line
  function splitLines(html) {
    var tpl = doc.createElement('template'); tpl.innerHTML = html;
    var lines = [el('span', 'ui-code-line-text')];
    function append(ancestors, text) {
      var cur = lines[lines.length - 1];
      ancestors.forEach(function (a) {
        var last = cur.lastChild;
        if (!(last && last.nodeType === 1 && last.$src === a)) { last = el('span', a.className); last.$src = a; cur.appendChild(last); }
        cur = last;
      });
      cur.appendChild(doc.createTextNode(text));
    }
    function walk(node, ancestors) {
      Array.prototype.forEach.call(node.childNodes, function (child) {
        if (child.nodeType === 3) {
          var parts = child.data.split('\n');
          parts.forEach(function (p, i) { if (i) lines.push(el('span', 'ui-code-line-text')); if (p) append(ancestors, p); });
        } else if (child.nodeType === 1) walk(child, ancestors.concat(child));
      });
    }
    walk(tpl.content, []);
    if (lines.length > 1 && !lines[lines.length - 1].childNodes.length) lines.pop();   // the trailing newline
    return lines;
  }
  function unquote(s) { s = s.trim(); if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) return s.slice(1, -1); return s; }
  var YKEY = /^(\s*)(- )?((?:"[^"]*"|'[^']*'|[^\s"'#:-][^:]*?))\s*:(?: |$)/;
  var YITEM = /^(\s*)- /;
  var JKEY = /^(\s*)"((?:[^"\\]|\\.)*)":/;
  // the structure of each line from the text itself: its indent, key, path (metadata.labels.app, spec.containers[0]
  // .image) and the block it opens; in JSON a block runs from a line ending with { or [ to its closing bracket,
  // in YAML over the lines indented deeper
  function structure(text, format) {
    var raw = text.replace(/\n$/, '').split('\n');
    var rows = [], stack = [], counters = {};
    function item(row, indent) {
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      var parentPath = stack.length ? stack[stack.length - 1].path : '';
      var ck = parentPath + '@' + indent;
      counters[ck] = counters[ck] === undefined ? 0 : counters[ck] + 1;
      row.item = true; row.path = parentPath + '[' + counters[ck] + ']';
      stack.push({ indent: indent, path: row.path });
    }
    function keyed(row, indent, key) {
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      row.key = key; row.path = (stack.length ? stack[stack.length - 1].path + '.' : '') + key;
      stack.push({ indent: indent, path: row.path });
    }
    raw.forEach(function (line, i) {
      var indent = (line.match(/^\s*/) || [''])[0].length;
      var trimmed = line.trim();
      var row = { i: i, raw: line, text: line, indent: indent, key: null, path: '', item: false, opens: false, end: i, masked: /MASKED_VALUE_\d+/.test(line), closer: false };
      if (format === 'json') {
        var m = JKEY.exec(line);
        if (m) keyed(row, indent, m[2]);
        else if (trimmed === '}' || trimmed === '},' || trimmed === ']' || trimmed === '],') row.closer = true;
        else if (trimmed && stack.length) item(row, indent);   // a value inside an array ({, [ or a scalar)
        row.opens = /[{[]$/.test(trimmed);
      } else {
        var it = YITEM.exec(line), km = YKEY.exec(line);
        if (it) {
          item(row, it[1].length);
          // "- name: web": the item opens a mapping on the same line; its other keys sit two columns in
          if (km) { var k = unquote(km[3]); row.key = k; row.path = row.path + '.' + k; stack.push({ indent: it[1].length + 2, path: row.path }); }
        } else if (km) keyed(row, indent, unquote(km[3]));
      }
      rows.push(row);
    });
    for (var a = 0; a < rows.length; a++) {
      var b;
      if (format === 'json') {
        if (!rows[a].opens) continue;
        b = a + 1;
        while (b < rows.length && !(rows[b].closer && rows[b].indent === rows[a].indent)) b++;
        if (b < rows.length && b > a + 1) rows[a].end = b; else rows[a].opens = false;
      } else {
        var base = rows[a].item ? rows[a].indent + 1 : rows[a].indent;
        b = a + 1;
        while (b < rows.length && (rows[b].text.trim() === '' || rows[b].indent > base)) b++;
        var endAt = b - 1;
        while (endAt > a && rows[endAt].text.trim() === '') endAt--;
        if (endAt > a) { rows[a].opens = true; rows[a].end = endAt; }
      }
    }
    return rows;
  }
  // every match of q in the line's text, wrapped in <mark>; the line's structure (spans) is kept; returns the marks
  function markIn(code, q) {
    var marks = [];
    if (!q) return marks;
    var walker = doc.createTreeWalker(code, NodeFilter.SHOW_TEXT, null);
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);
    var text = nodes.map(function (t) { return t.data; }).join('');
    var lower = text.toLowerCase(), ql = q.toLowerCase(), hits = [], at = 0, idx;
    while ((idx = lower.indexOf(ql, at)) >= 0) { hits.push(idx); at = idx + ql.length; }
    if (!hits.length) return marks;
    var starts = [], pos = 0; nodes.forEach(function (t) { starts.push(pos); pos += t.data.length; });
    function locate(off) { for (var i = nodes.length - 1; i >= 0; i--) if (starts[i] <= off) return { node: nodes[i], offset: off - starts[i] }; return { node: nodes[0], offset: 0 }; }
    for (var h = hits.length - 1; h >= 0; h--) {   // from the last hit back, so the earlier offsets stay valid
      var s = locate(hits[h]), e = locate(hits[h] + ql.length);
      var range = doc.createRange(); range.setStart(s.node, s.offset); range.setEnd(e.node, e.offset);
      var mark = el('mark', 'ui-code-mark'); mark.appendChild(range.extractContents()); range.insertNode(mark);
      marks.unshift(mark);
    }
    return marks;
  }
  function render(host, obj, opts) {
    opts = opts || {};
    host.textContent = '';
    host.classList.add('ui-code-view');
    var originals = [];
    var source = prepare(obj, opts, originals, '', false);
    var format = opts.format === 'yaml' ? 'yaml' : 'json';
    var state = { format: format, query: '', filter: false, matches: [], at: -1, revealAll: false, revealed: {}, folded: {} };
    var text, rows, codes, lineEls = [];
    // the toolbar
    var bar = el('div', 'ui-code-bar');
    var field = el('label', 'ui-field ui-code-search'); field.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4" stroke-linecap="round"/></svg>';
    var search = el('input', 'ui-input'); search.type = 'search'; search.placeholder = 'Search'; search.setAttribute('aria-label', 'Search the ' + format.toUpperCase()); search.autocomplete = 'off'; field.appendChild(search);
    var count = el('span', 'ui-status ui-code-count'); count.setAttribute('aria-live', 'polite');
    var prev = el('button', 'btn btn-secondary btn-sm', 'Previous'); prev.type = 'button'; prev.disabled = true;
    var next = el('button', 'btn btn-secondary btn-sm', 'Next'); next.type = 'button'; next.disabled = true;
    var filter = el('label', 'ui-check-label'); var filterBox = el('input', 'ui-check'); filterBox.type = 'checkbox'; filter.appendChild(filterBox); filter.appendChild(doc.createTextNode('Filter lines'));
    var wrap = el('label', 'ui-check-label'); var wrapBox = el('input', 'ui-check'); wrapBox.type = 'checkbox'; wrap.appendChild(wrapBox); wrap.appendChild(doc.createTextNode('Wrap'));
    var foldAll = el('button', 'btn btn-secondary btn-sm', 'Fold all'); foldAll.type = 'button';
    var unfoldAll = el('button', 'btn btn-secondary btn-sm', 'Unfold all'); unfoldAll.type = 'button';
    var reveal = el('button', 'btn btn-secondary btn-sm', 'Reveal secrets'); reveal.type = 'button';
    var copy = el('button', 'btn btn-secondary btn-sm', 'Copy JSON'); copy.type = 'button';
    var formats = el('div', 'ui-code-formats'); formats.setAttribute('role', 'group'); formats.setAttribute('aria-label', 'Format');
    var asJson = el('button', 'ui-chip', 'JSON'); asJson.type = 'button'; asJson.setAttribute('data-format', 'json');
    var asYaml = el('button', 'ui-chip', 'YAML'); asYaml.type = 'button'; asYaml.setAttribute('data-format', 'yaml');
    formats.appendChild(asJson); formats.appendChild(asYaml);
    if (opts.yaml === false || !(window.jsyaml && window.jsyaml.dump)) formats.hidden = true;
    [field, count, prev, next, filter, wrap, foldAll, unfoldAll, reveal, copy, formats].forEach(function (n) { bar.appendChild(n); });
    if (!originals.length) reveal.hidden = true;
    var box = el('div', 'ui-code-lines'); box.setAttribute('role', 'region'); box.setAttribute('aria-label', 'The object as ' + format.toUpperCase());
    host.appendChild(bar); host.appendChild(box);
    function shown(idx) { return state.revealAll || !!state.revealed[idx]; }
    function masks(code, row) {
      // the sentinels become masked values with Reveal; the row's text (what a search sees) takes the dots or,
      // once revealed, the value
      row.text = row.raw.replace(/MASKED_VALUE_(\d+)/g, function (_, n) { return shown(Number(n)) ? String(originals[Number(n)]) : DOTS; });
      var walker = doc.createTreeWalker(code, NodeFilter.SHOW_TEXT, null), n, found = [];
      while ((n = walker.nextNode())) { var mm = SENTINEL.exec(n.data.trim()); if (mm) found.push([n, Number(mm[1])]); }
      found.forEach(function (f) {
        var node = f[0], idx = f[1];
        var quoted = node.data.trim().charAt(0) === '"', comma = /,$/.test(node.data.trim());
        var span = el('span', 'ui-code-masked');
        if (quoted) span.appendChild(doc.createTextNode('"'));
        if (shown(idx)) span.appendChild(el('span', 'ui-code-revealed', String(originals[idx])));
        else span.appendChild(el('span', 'ui-masked-dots', DOTS));
        if (quoted) span.appendChild(doc.createTextNode('"'));
        if (comma) span.appendChild(doc.createTextNode(','));
        var b = el('button', 'ui-link ui-code-reveal', shown(idx) ? 'Hide' : 'Reveal'); b.type = 'button'; b.setAttribute('data-reveal', String(idx));
        span.appendChild(doc.createTextNode(' ')); span.appendChild(b);
        node.parentNode.replaceChild(span, node);
      });
    }
    function keyButton(code, row) {
      if (!row.key) return;
      var k = code.querySelector('.hljs-attr');
      if (k) { k.setAttribute('data-copy', row.path); k.title = 'Copy the path ' + row.path; k.setAttribute('role', 'button'); k.tabIndex = 0; }
    }
    function lineText(row, i) {
      var code = codes[i] ? codes[i].cloneNode(true) : el('span', 'ui-code-line-text', row.text);
      if (row.masked) masks(code, row);
      keyButton(code, row);
      return code;
    }
    function build() {
      box.textContent = ''; lineEls = [];
      rows.forEach(function (row, i) {
        var line = el('div', 'ui-code-line'); line.setAttribute('data-n', String(i + 1)); if (row.path) line.setAttribute('data-path', row.path);
        if (row.opens) {
          var folded = !!state.folded[row.path || '#' + i];
          var tg = el('button', 'ui-code-fold'); tg.type = 'button'; tg.setAttribute('data-fold', row.path || '#' + i); tg.setAttribute('aria-label', (folded ? 'Unfold ' : 'Fold ') + (row.path || 'the block')); tg.setAttribute('aria-expanded', folded ? 'false' : 'true'); tg.textContent = folded ? '▸' : '▾';
          line.appendChild(tg);
        }
        line.appendChild(lineText(row, i));
        if (row.opens && state.folded[row.path || '#' + i]) line.appendChild(el('span', 'ui-code-folded', ' … ' + (row.end - row.i) + ' lines'));
        box.appendChild(line); lineEls.push(line);
      });
      show();
    }
    // which lines are on view: inside a folded block, or filtered out
    function show() {
      var hiddenTo = -1, q = state.query;
      rows.forEach(function (row, i) {
        var inFold = i <= hiddenTo;
        lineEls[i].hidden = inFold || (state.filter && q && !row.$match);
        if (!inFold && row.opens && state.folded[row.path || '#' + i]) hiddenTo = row.end;
      });
    }
    function mark() {
      var q = state.query;
      state.matches = [];
      rows.forEach(function (row, i) {
        var fresh = lineText(row, i);
        var old = lineEls[i].querySelector('.ui-code-line-text');
        old.parentNode.replaceChild(fresh, old);
        row.$match = !!q && row.text.toLowerCase().indexOf(q.toLowerCase()) >= 0;
        lineEls[i].classList.toggle('ui-code-hit', row.$match);
        if (row.$match) markIn(fresh, q).forEach(function (m) { state.matches.push({ line: i, mark: m }); });
      });
      count.textContent = q ? (state.matches.length ? (state.at + 1) + ' of ' + state.matches.length : 'no match') : '';
      prev.disabled = next.disabled = state.matches.length < 2;
      show();
      current();
    }
    function current() {
      Array.prototype.forEach.call(box.querySelectorAll('.ui-code-current'), function (m) { m.classList.remove('ui-code-current'); });
      if (state.at < 0 || !state.matches.length) return;
      var m = state.matches[state.at];
      var opened = false;   // a match inside a folded block unfolds it
      rows.forEach(function (row, i) { var id = row.path || '#' + i; if (row.opens && state.folded[id] && m.line > row.i && m.line <= row.end) { state.folded[id] = false; opened = true; } });
      if (opened) { build(); mark(); return; }
      m.mark.classList.add('ui-code-current');
      count.textContent = (state.at + 1) + ' of ' + state.matches.length;
      // the viewer's own box scrolls to the match (never the page: the pane around the frame stays put)
      var line = lineEls[m.line];
      host.scrollTop = Math.max(0, line.offsetTop - host.clientHeight / 2 + line.offsetHeight / 2);
    }
    function go(d) { if (!state.matches.length) return; state.at = (state.at + d + state.matches.length) % state.matches.length; current(); }
    function copyText() { copy.setAttribute('data-copy', plain(false)); copy.textContent = 'Copy ' + state.format.toUpperCase(); }
    function plain(all) { return rows.map(function (r) { return r.raw.replace(/MASKED_VALUE_(\d+)/g, function (_, n) { return all || shown(Number(n)) ? String(originals[Number(n)]) : '******'; }); }).join('\n') + '\n'; }
    var loadGen = 0;
    function load(fmt) {
      state.format = fmt;
      text = textOf(source, fmt);
      rows = structure(text, fmt);
      // the plain lines at once; the coloured ones replace them when the highlighter answers (unless a newer load ran)
      codes = splitLines(escapeText(text));
      var gen = ++loadGen;
      highlight(text, fmt).then(function (html) { if (gen !== loadGen) return; codes = splitLines(html); build(); if (state.query) mark(); copyText(); });
      state.folded = {};
      var byPath = {}; rows.forEach(function (r) { if (r.opens && r.key && byPath[r.path] === undefined) byPath[r.path] = r.i; });
      (opts.fold || ['metadata.managedFields']).forEach(function (p) { if (byPath[p] !== undefined) state.folded[p] = true; });
      asJson.classList.toggle('ui-on', fmt === 'json'); asYaml.classList.toggle('ui-on', fmt === 'yaml');
      asJson.setAttribute('aria-pressed', fmt === 'json' ? 'true' : 'false'); asYaml.setAttribute('aria-pressed', fmt === 'yaml' ? 'true' : 'false');
      search.setAttribute('aria-label', 'Search the ' + fmt.toUpperCase()); box.setAttribute('aria-label', 'The object as ' + fmt.toUpperCase());
      build(); if (state.query) mark(); copyText();
    }
    var timer = null;
    search.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { state.query = search.value.trim(); state.at = state.query ? 0 : -1; mark(); }, 120); });
    search.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); } });
    next.addEventListener('click', function () { go(1); });
    prev.addEventListener('click', function () { go(-1); });
    filterBox.addEventListener('change', function () { state.filter = filterBox.checked; show(); });
    wrapBox.addEventListener('change', function () { host.classList.toggle('ui-code-wrap', wrapBox.checked); });
    foldAll.addEventListener('click', function () { rows.forEach(function (r, i) { if (r.opens && r.key && r.indent === (state.format === 'json' ? 2 : 0)) state.folded[r.path || '#' + i] = true; }); build(); mark(); });
    unfoldAll.addEventListener('click', function () { state.folded = {}; build(); mark(); });
    reveal.addEventListener('click', function () { state.revealAll = !state.revealAll; reveal.textContent = state.revealAll ? 'Hide secrets' : 'Reveal secrets'; build(); mark(); copyText(); });
    formats.addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('[data-format]') : null; if (b && b.getAttribute('data-format') !== state.format) load(b.getAttribute('data-format')); });
    box.addEventListener('click', function (e) {
      var t = e.target;
      var f = t.closest ? t.closest('[data-fold]') : null;
      if (f) { var p = f.getAttribute('data-fold'); state.folded[p] = !state.folded[p]; build(); mark(); return; }
      var r = t.closest ? t.closest('[data-reveal]') : null;
      if (r) { var idx = Number(r.getAttribute('data-reveal')); state.revealed[idx] = !state.revealed[idx]; build(); mark(); copyText(); }
    });
    box.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.hljs-attr[data-copy]')) { e.preventDefault(); e.target.click(); } });
    load(format);
    return { search: function (q) { search.value = q; state.query = q; state.at = q ? 0 : -1; mark(); }, text: function () { return plain(true); }, format: function (f) { if (f) load(f); return state.format; }, state: state, rows: function () { return rows; } };
  }
  window.diagCode = { render: render, text: function (obj, format) { return textOf(prepare(obj, { mask: false }, [], '', false), format || 'json'); }, secretish: function (k) { return SECRETISH.test(String(k || '')); } };
})();

/*
  diagPopover: a panel that opens beside a control (the Log Viewer's file picker and calendar). Two things the frame
  cannot see on its own decide where a panel fits. The frame never scrolls - the pane around it does - so the room
  below the control is measured against the pane's viewport (window.diagnosticsViewport, in frame coordinates),
  never window.innerHeight (the frame's whole height): measured by the frame's height a panel opened upward and sat
  above the pane's view with its top cut off. And a fixed panel cannot paint past the iframe's own box, which ends
  with the content: a panel below a control near the content's end was cut at the iframe's bottom edge. So while a
  panel is open the body's min-height reaches the panel's bottom; the height bridge (the parent's ResizeObserver
  message) grows the iframe under it, and the body's min-height goes back on close, so the iframe shrinks again.
  When the host does not follow (the frame stays short), the panel is placed again with the frame's bottom as its
  floor. The panel opens below the control by default, flips above only when the room below is under minHeight and
  the room above is larger, and takes the room it has as its max-height (its .ui-popover-body scrolls; a
  .ui-popover-head stays at the top, a .ui-popover-foot at the bottom).
    diagPopover.open(panel, anchor, { maxHeight: 480, minHeight: 200 | 'natural', focus: input, align: 'left' | 'right' })
    diagPopover.close(panel)   diagPopover.place(panel, anchor, opts)   diagPopover.isOpen(panel)
  A panel hidden any other way (the class "hidden" added by its own close paths) is released the same: the body's
  min-height follows the panels still open.
*/
(function () {
  var MARGIN = 8, GAP = 4, SETTLE_MS = 350;
  var openPanels = [];
  var savedMinHeight = null;
  function viewport() {
    var vp = window.diagnosticsViewport;
    if (vp && vp.height) return { top: vp.top, height: vp.height };
    return { top: window.scrollY || 0, height: window.innerHeight };
  }
  function frameHeight() { return document.documentElement.clientHeight; }
  function grow() {
    // the body's min-height reaches the lowest open panel (what the height bridge measures), or goes back
    var need = 0;
    openPanels.forEach(function (p) { if (!p.classList.contains('hidden')) need = Math.max(need, p.getBoundingClientRect().bottom + MARGIN + GAP); });
    if (!document.body) return;
    if (need > 0) {
      if (savedMinHeight === null) savedMinHeight = document.body.style.minHeight || '';
      document.body.style.minHeight = Math.ceil(need) + 'px';
    } else if (savedMinHeight !== null) {
      document.body.style.minHeight = savedMinHeight;
      savedMinHeight = null;
    }
  }
  function release(panel) {
    var i = openPanels.indexOf(panel);
    if (i >= 0) openPanels.splice(i, 1);
    grow();
  }
  function watch(panel) {
    if (panel.$popoverWatch || !window.MutationObserver) return;
    panel.$popoverWatch = new MutationObserver(function () { if (panel.classList.contains('hidden')) release(panel); });
    panel.$popoverWatch.observe(panel, { attributes: true, attributeFilter: ['class'] });
  }
  function place(panel, anchor, opts, capToFrame) {
    opts = opts || {};
    var vp = viewport();
    var r = anchor.getBoundingClientRect();
    var frameW = document.documentElement.clientWidth;
    var want = opts.maxHeight || 480;
    var useful = opts.minHeight || 200;
    if (useful === 'natural') { panel.style.maxHeight = 'none'; useful = Math.min(want, panel.offsetHeight); }
    var viewBottom = vp.top + vp.height;
    // the floor: the pane's view (the frame grows under the panel), or the frame's own bottom when it cannot
    var floor = capToFrame ? Math.min(viewBottom, frameHeight()) : viewBottom;
    var below = floor - r.bottom - GAP - MARGIN;
    var above = r.top - Math.max(vp.top, 0) - GAP - MARGIN;
    var up = below < Math.min(want, useful) && above > below;
    var room = Math.max(120, up ? above : below);
    panel.style.maxHeight = Math.min(want, room) + 'px';
    var h = panel.offsetHeight, w = panel.offsetWidth;
    var top = up ? r.top - GAP - h : r.bottom + GAP;
    var left = opts.align === 'right' ? r.right - w : r.left;
    left = Math.max(MARGIN, Math.min(left, frameW - w - MARGIN));
    panel.style.top = Math.round(top) + 'px';
    panel.style.left = Math.round(left) + 'px';
    panel.setAttribute('data-placement', up ? 'above' : 'below');
    grow();
  }
  function open(panel, anchor, opts) {
    opts = opts || {};
    watch(panel);
    panel.classList.remove('hidden');
    if (openPanels.indexOf(panel) < 0) openPanels.push(panel);
    place(panel, anchor, opts);
    if (opts.focus) { try { opts.focus.focus({ preventScroll: true }); } catch { opts.focus.focus(); } }
    // the frame grows through the parent (asynchronously); a host that leaves it short gets the panel capped to it
    setTimeout(function () {
      if (panel.classList.contains('hidden')) return;
      if (panel.getBoundingClientRect().bottom + MARGIN > frameHeight() + 1) place(panel, anchor, opts, true);
    }, SETTLE_MS);
  }
  function close(panel) { panel.classList.add('hidden'); release(panel); }
  function isOpen(panel) { return !panel.classList.contains('hidden'); }
  window.diagPopover = { open: open, close: close, place: place, isOpen: isOpen };
})();

/*
  diagDateRange: the date-range picker (the Log Viewer's calendar; a shared component for any range control). Mounted on
  the calendar markup of tabs/_log_view.html: the month title (.ui-dr-title), the previous / next buttons (.ui-dr-prev,
  .ui-dr-next), the day grid (.ui-dr-grid), Today (.ui-dr-today) and Clear (.ui-dr-clear). The days are plain buttons
  (exempt from the frame's generic button rule): the range's start and end in the selected role, the days between on a
  soft band with rounded ends, today ringed, the other months' days muted, the days outside the bounds disabled with a
  tooltip. The first click sets the start, the second the end (the two swapped when it lies before the start); with a
  start and no end, hovering previews the band. Arrow keys move the focus a day or a week, PageUp / PageDown a month,
  Home / End to the week's ends, Enter or Space select, Escape closes. Every date is a UTC midnight.
    diagDateRange.mount(root, { min, max, start, end, onChange(start, end, done), onClose(), onClear() })
      .set(start, end)   .bounds(min, max)   .view(date)   .focus()   .render()   .state()
*/
(function () {
  var DAY = 86400000;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function utc(y, m, d) { return new Date(Date.UTC(y, m, d)); }
  function mid(d) { return d instanceof Date && !isNaN(d) ? utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : null; }
  function key(d) { return d.toISOString().slice(0, 10); }
  function same(a, b) { return !!a && !!b && a.getTime() === b.getTime(); }
  function month1(d) { return utc(d.getUTCFullYear(), d.getUTCMonth(), 1); }
  function mount(root, opts) {
    opts = opts || {};
    var title = root.querySelector('.ui-dr-title'), grid = root.querySelector('.ui-dr-grid');
    var prev = root.querySelector('.ui-dr-prev'), next = root.querySelector('.ui-dr-next');
    var today = root.querySelector('.ui-dr-today'), clear = root.querySelector('.ui-dr-clear');
    var now = new Date();
    var todayUtc = utc(now.getFullYear(), now.getMonth(), now.getDate());
    var st = { min: mid(opts.min), max: mid(opts.max), start: mid(opts.start), end: mid(opts.end), hover: null, view: null, focus: null };
    function off(d) { return (st.min && d < st.min) || (st.max && d > st.max); }
    function band() {
      var a = st.start, b = st.end || (st.start && st.hover ? st.hover : null);
      if (!a || !b) return null;
      return a <= b ? [a, b] : [b, a];
    }
    function render() {
      if (!st.view) st.view = month1(st.start || st.max || todayUtc);
      var y = st.view.getUTCFullYear(), m = st.view.getUTCMonth();
      if (title) title.textContent = MONTHS[m] + ' ' + y;
      var lead = utc(y, m, 1).getUTCDay();
      var bd = band(), preview = !st.end;
      var focusKey = st.focus ? key(st.focus) : (st.start ? key(st.start) : null);
      grid.innerHTML = '';
      var focused = false;
      for (var i = 0; i < 42; i++) {
        var d = utc(y, m, 1 - lead + i);
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'ui-dr-day'; b.textContent = String(d.getUTCDate()); b.dataset.date = key(d);
        b.setAttribute('role', 'gridcell'); b.tabIndex = -1;
        var dis = off(d);
        if (d.getUTCMonth() !== m) b.classList.add('ui-dr-out');
        if (dis) { b.disabled = true; b.classList.add('ui-dr-off'); b.title = 'Outside the logs\' dates' + (st.min && st.max ? ' (' + key(st.min) + ' to ' + key(st.max) + ')' : ''); }
        if (same(d, todayUtc)) b.classList.add('ui-dr-today');
        if (same(d, st.start)) { b.classList.add('ui-dr-start'); if (st.end && !same(st.start, st.end)) b.classList.add('ui-dr-has-end'); }
        if (same(d, st.end)) { b.classList.add('ui-dr-end'); if (!same(st.start, st.end)) b.classList.add('ui-dr-has-end'); }
        if (bd && d > bd[0] && d < bd[1]) b.classList.add(preview ? 'ui-dr-preview' : 'ui-dr-in');
        if (bd && preview && same(d, st.hover) && !same(d, st.start)) b.classList.add('ui-dr-preview-end');
        if (focusKey && key(d) === focusKey && !dis) { b.tabIndex = 0; focused = true; }
        grid.appendChild(b);
      }
      if (!focused) { var first = grid.querySelector('.ui-dr-day:not(:disabled):not(.ui-dr-out)') || grid.querySelector('.ui-dr-day:not(:disabled)'); if (first) first.tabIndex = 0; }
      if (today) { today.disabled = !!off(todayUtc); today.title = today.disabled ? 'Today lies outside the logs\' dates' : ''; }
    }
    function dateOf(b) { return new Date(b.dataset.date + 'T00:00:00Z'); }
    function pick(d) {
      if (off(d)) return;
      if (!st.start || st.end) { st.start = d; st.end = null; }
      else { st.end = d; if (st.end < st.start) { var t = st.start; st.start = st.end; st.end = t; } }
      st.hover = null; st.focus = d;
      var had = grid.contains(document.activeElement);
      render();
      if (had) focus();   // the grid is rebuilt: the keyboard stays on the picked day
      if (opts.onChange) opts.onChange(st.start, st.end, !!st.end);
    }
    function focus() { var b = grid.querySelector('.ui-dr-day[tabindex="0"]'); if (b) { try { b.focus({ preventScroll: true }); } catch { b.focus(); } } }
    function moveTo(d) { st.focus = d; st.view = month1(d); render(); focus(); }
    grid.addEventListener('click', function (e) { var b = e.target.closest('.ui-dr-day'); if (b && !b.disabled) pick(dateOf(b)); });
    grid.addEventListener('mouseover', function (e) {
      var b = e.target.closest('.ui-dr-day');
      if (!b || b.disabled || !st.start || st.end) return;
      var d = dateOf(b);
      if (!same(d, st.hover)) { st.hover = d; render(); }
    });
    grid.addEventListener('mouseleave', function () { if (st.hover) { st.hover = null; render(); } });
    grid.addEventListener('keydown', function (e) {
      var b = e.target.closest ? e.target.closest('.ui-dr-day') : null;
      if (!b) return;
      var d = dateOf(b), k = e.key;
      if (k === 'ArrowLeft') moveTo(new Date(d.getTime() - DAY));
      else if (k === 'ArrowRight') moveTo(new Date(d.getTime() + DAY));
      else if (k === 'ArrowUp') moveTo(new Date(d.getTime() - 7 * DAY));
      else if (k === 'ArrowDown') moveTo(new Date(d.getTime() + 7 * DAY));
      else if (k === 'PageUp') moveTo(utc(d.getUTCFullYear(), d.getUTCMonth() - 1, Math.min(d.getUTCDate(), 28)));
      else if (k === 'PageDown') moveTo(utc(d.getUTCFullYear(), d.getUTCMonth() + 1, Math.min(d.getUTCDate(), 28)));
      else if (k === 'Home') moveTo(new Date(d.getTime() - d.getUTCDay() * DAY));
      else if (k === 'End') moveTo(new Date(d.getTime() + (6 - d.getUTCDay()) * DAY));
      else if (k === 'Enter' || k === ' ') pick(d);
      else if (k === 'Escape') { if (opts.onClose) opts.onClose(); }
      else return;
      e.preventDefault(); e.stopPropagation();
    });
    root.addEventListener('keydown', function (e) { if (e.key === 'Escape' && opts.onClose) { e.preventDefault(); e.stopPropagation(); opts.onClose(); } });
    if (prev) prev.addEventListener('click', function () { st.view = utc(st.view.getUTCFullYear(), st.view.getUTCMonth() - 1, 1); render(); });
    if (next) next.addEventListener('click', function () { st.view = utc(st.view.getUTCFullYear(), st.view.getUTCMonth() + 1, 1); render(); });
    if (today) today.addEventListener('click', function () { if (off(todayUtc)) return; st.start = st.end = st.focus = todayUtc; st.hover = null; st.view = null; render(); if (opts.onChange) opts.onChange(st.start, st.end, true); });
    if (clear) clear.addEventListener('click', function () { st.start = st.end = st.hover = null; render(); if (opts.onClear) opts.onClear(); });
    var api = {
      set: function (start, end) { st.start = mid(start); st.end = mid(end); st.hover = null; st.focus = st.start; if (st.start) st.view = month1(st.start); render(); return api; },
      bounds: function (min, max) { st.min = mid(min); st.max = mid(max); render(); return api; },
      view: function (d) { d = mid(d); st.view = month1(d || st.start || st.max || todayUtc); render(); return api; },
      focus: focus,
      render: render,
      state: function () { return { start: st.start, end: st.end, min: st.min, max: st.max, view: st.view }; },
    };
    render();
    return api;
  }
  window.diagDateRange = { mount: mount };
})();

/*
  diagLogView: the one Log Viewer of the Diagnostics pages. The presentation (the charts row, the date range with its
  calendar and dual slider, the source picker, Get Date Range / Load Logs / Export CSV, the status, the filter row,
  the table, the pager, the busy state, the keyboard and the cross-link search) lives here and in
  tabs/_log_view.html; the data comes through an adapter the page picks, so a sosreport and a must-gather read the
  same way and an improvement lands on both:

    window.diagLogView.mount(root, adapter)
    adapter = {
      dateRange: { start, end } | null,          // the initial slider bounds (ISO strings)
      getRange(paths) -> Promise<{ start, end }>, // the earliest / latest timestamps of the selected sources
      load({ paths, start, end, search, exclude, level, source }, onEntries(entries, totalCount), onProgress({ entries, filesDone, filesTotal })) -> { done: Promise, cancel() },
        search / exclude: the terms of the filter fields at Load Logs (plain substrings, any-of / none-of), level
        and source (the group key) likewise: the adapter applies them server-side, so the rows that arrive are
        the matches across every selected file; the fields keep filtering what is loaded afterwards
    A cross-link "sources=<a>,<b>[&q=<term>]" (diagLogView.applyQuery, via diagLinks) checks the sources it names
    and nothing else, reads their date range, loads them and puts the term in the search: <ns>/<pod> is every
    container log of the pod (current and previous), <ns>/<pod>/<container> one container's, node:<node> the node's
    journals, host:<role> the role's host service logs, host:<role>/<file> one of them, any other value a source's
    listed name (a sosreport's file).
        onProgress after every page / chunk, rows or not: the viewer's "Loading logs… N entries (k of n files)" line and pill
      exportPrefix: 'logs',                       // the CSV file name
    }
    a row: { timestamp, timestamp_obj, severity, hostname, process, pid, message, badges?: [{ kind, text, title }], src? }
    group(row) -> { key, label, title } (optional): what the source chart and the source select group the rows by;
      without it the rows group by their process. chartTitle / sourceLabel name the card and the select's first
      option (the template's chart_title / source_label arguments say the same before the viewer mounts).

  diagLogView.adapters.sosreport({ directory, dateRange }): the journal / syslog files through the streamed parse
  (/parse_log_viewer_stream) and /get_log_date_range. diagLogView.adapters.mustgather({ directory, dateRange }): the
  container / host service / node logs page by page through /mustgather_log_search (cancel: /mustgather_log_cancel). Every element id is the contract with the markup, the driver
  scripts and the tests (log-search, log-exclude, severity-filter, process-filter, load-logs-btn, date-slider-* ...).
*/
(function () {
  // the SSE text the parent forwards ("data: {...}\n\n" messages), reassembled chunk by chunk
  function sseReader(onChunk) {
    let buffer = '';
    return (text) => {
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.substring(6);
        if (!jsonStr.trim()) continue;
        let chunk;
        try { chunk = JSON.parse(jsonStr); } catch (e) { console.error('[Log Viewer] Error parsing chunk:', e); continue; }
        onChunk(chunk);
      }
    };
  }
  const adapters = {
    // the must-gather: the container, host service and node logs the gather lists, read page by page through
    // /mustgather_log_search (the server reads from a cursor for a limit of rows or a time budget per call; the
    // rows arrive in the viewer as each page lands); Abort stops the paging and cancels the running call
    mustgather(opts) {
      opts = opts || {};
      const PAGE = 2000;
      return {
        kind: 'mustgather',
        dateRange: opts.dateRange || null,
        exportPrefix: 'mustgather-logs',
        gatherTime: opts.gatherTime || null,
        chartTitle: 'Logs per Source',
        sourceLabel: 'All Sources',
        // the rows grouped by what wrote them: a container (ns/pod/container), a host service, a node's journal
        group(entry) {
          if (entry.src === 'host') { const svc = entry.service || entry.process; return { key: 'host:' + svc, label: svc, title: `${svc} (host service log)` }; }
          if (entry.src === 'node') return { key: 'node:' + entry.hostname, label: entry.hostname, title: `${entry.hostname} (node journal)` };
          const key = `${entry.hostname}/${entry.process}`;
          return { key, label: key, title: `${key} (container)` };
        },
        async getRange(paths) {
          // the must-gather's own reader (/mustgather_log_date_range): the head and tail of each selected log, every
          // line format the search knows; logs without timestamps come back named, never as an error
          const response = await window.diagnosticsApiRequest('/mustgather_log_date_range', { directory: opts.directory, paths });
          if (!response.ok) throw new Error((response.json && response.json.error) || 'Failed to get date range');
          const r = response.json || {};
          return { start: r.start, end: r.end, untimestamped: r.untimestamped || [], timestamped: r.timestamped || 0 };
        },
        load(params, onEntries, onProgress) {
          let cancelled = false;
          const done = (async () => {
            let cursor = null;
            let total = 0;
            const filesTotal = (params.paths || []).length;
            for (;;) {
              const body = { directory: opts.directory, paths: params.paths, limit: PAGE };
              if (params.start) body.start = params.start;
              if (params.end) body.end = params.end;
              if (params.search && params.search.length) body.query = params.search;
              if (params.exclude && params.exclude.length) body.exclude = params.exclude;
              if (params.level) body.level = params.level;
              if (params.source) body.source = params.source;
              if (cursor) body.cursor = cursor;
              const response = await window.diagnosticsApiRequest('/mustgather_log_search', body);
              if (cancelled) return { ok: true, cancelled: true };
              const r = response.json || {};
              if (!response.ok) throw new Error(r.cancelled ? 'The search was cancelled' : (r.error || r.message || 'The search failed'));
              total += (r.entries || []).length;
              onEntries(r.entries || [], total);
              // every page reports, rows or not: a long scan with few matches still shows its way through the files
              if (onProgress) onProgress({ entries: total, filesDone: r.done || !r.cursor ? (r.files || filesTotal) : Math.min(r.cursor.file || 0, r.files || filesTotal), filesTotal: r.files || filesTotal });
              if (r.done || !r.cursor) return { ok: true };
              cursor = r.cursor;
            }
          })();
          return {
            done,
            cancel: () => { cancelled = true; window.diagnosticsApiRequest('/mustgather_log_cancel', { directory: opts.directory }).catch(() => {}); },
          };
        },
      };
    },
    sosreport(opts) {
      opts = opts || {};
      return {
        kind: 'sosreport',
        dateRange: opts.dateRange || null,
        exportPrefix: 'logs',
        async getRange(paths) {
          // the calls go through the trusted parent window (the sandboxed frame cannot attach the app token itself):
          // window.diagnosticsApiRequest and the allowlisted proxy in src/components/DiagnosticsPage.jsx
          const response = await window.diagnosticsApiRequest('/get_log_date_range', { directory: opts.directory, log_paths: paths });
          if (!response.ok) throw new Error((response.json && response.json.error) || 'Failed to get date range');
          return (response.json && response.json.date_range) || {};
        },
        load(params, onEntries, onProgress) {
          let failure = null;
          const filesTotal = (params.paths || []).length;
          const read = sseReader((chunk) => {
            if (chunk.error) { failure = new Error(chunk.error); return; }
            if (chunk.done) return;
            if (chunk.entries && chunk.entries.length) onEntries(chunk.entries, chunk.total_count);
            // the file count only when the stream names its file (an older backend's chunks do not)
            if (onProgress) onProgress({ entries: chunk.total_count || 0, filesDone: chunk.file || 0, filesTotal: chunk.file ? (chunk.files || filesTotal) : 0 });
          });
          const body = { directory: opts.directory, start_date: params.start, end_date: params.end, log_paths: params.paths };
          if (params.search && params.search.length) body.query = params.search;
          if (params.exclude && params.exclude.length) body.exclude = params.exclude;
          if (params.level) body.level = params.level;
          if (params.source) body.process = params.source;
          const stream = window.diagnosticsApiStream('/parse_log_viewer_stream', body, read);
          return { done: stream.done.then((r) => { if (failure) throw failure; return r; }), cancel: () => stream.cancel() };
        },
      };
    },
  };

function mount(root, adapter) {
  if (!root || !adapter) return null;
  const root0 = root;
  const loadLogsBtn = document.getElementById('load-logs-btn');
  const getRangeBtn = document.getElementById('get-range-btn');
  const logFileDropdownBtn = document.getElementById('log-file-dropdown-btn');
  const logFileDropdownPanel = document.getElementById('log-file-dropdown-panel');
  const logFileSelectionDisplay = document.getElementById('log-file-selection-display');
  const logFileSearch = document.getElementById('log-file-search');
  const selectAllLogsBtn = document.getElementById('select-all-logs');
  const clearAllLogsBtn = document.getElementById('clear-all-logs');
  const dateSliderStart = document.getElementById('date-slider-start');
  const dateSliderEnd = document.getElementById('date-slider-end');
  const dateStartLabel = document.getElementById('date-start-label');
  const dateEndLabel = document.getElementById('date-end-label');
  const dateRangeHighlight = document.getElementById('date-range-highlight');
  const singleDateButton = document.getElementById('single-date-button');
  const singleDateDisplay = document.getElementById('single-date-display');
  const dateCalendar = document.getElementById('date-calendar');
  const loadingIndicator = document.getElementById('loading-indicator');

  let processChart = null;
  let severityChart = null;
  const logsLoadedInfo = document.getElementById('logs-loaded-info');
  const loadedCount = document.getElementById('loaded-count');
  const logTableBody = document.getElementById('log-table-body');
  const noResults = document.getElementById('no-results');
  const searchInput = document.getElementById('log-search');
  const severityFilter = document.getElementById('severity-filter');
  const processFilter = document.getElementById('process-filter');
  const entryCount = document.getElementById('entry-count');
  const pageInfo = document.getElementById('page-info');

  // Modal elements
  const alertModal = document.getElementById('alert-modal');
  const alertModalIcon = document.getElementById('alert-modal-icon');
  const alertModalTitle = document.getElementById('alert-modal-title');
  const alertModalMessage = document.getElementById('alert-modal-message');
  const alertModalOk = document.getElementById('alert-modal-ok');

  // Show alert modal
  function showAlert(title, message, type = 'info') {
    alertModalTitle.textContent = title;
    alertModalMessage.textContent = message;

    // the icon by type, in the role colours
    alertModalIcon.className = 'fas ui-modal-icon ' + ({ error: 'fa-exclamation-circle', warning: 'fa-exclamation-triangle', success: 'fa-check-circle' }[type] || 'fa-info-circle');
    alertModalIcon.style.color = ({ error: 'var(--chart-bad)', warning: 'var(--chart-warn)', success: 'var(--chart-good)' })[type] || 'var(--os-blue)';

    alertModal.classList.remove('hidden');
  }

  // Close modal
  alertModalOk?.addEventListener('click', () => {
    alertModal.classList.add('hidden');
  });

  // Close modal on background click
  alertModal?.addEventListener('click', (e) => {
    if (e.target === alertModal) {
      alertModal.classList.add('hidden');
    }
  });

  let allEntries = [];
  let filteredEntries = [];
  let loadScope = null;   // the last load: { filtered: the filters went server-side, files: the selected files }
  let currentPage = 0;
  let pageSize = 100;
  let sortColumn = -1;
  let sortAscending = true;

  // Loading state for abort functionality
  let isLoading = false;
  let busyHandle = null;   // the shared busy state (diagBusy) of the running load / range read
  let currentReader = null;

  // Update selection display
  function updateSelectionDisplay() {
    if (!logFileSelectionDisplay) return;   // a report without logs has no file picker (the Findings strip says so)
    const checkboxes = document.querySelectorAll('.log-file-checkbox:checked');
    const count = checkboxes.length;

    if (count === 0) {
      logFileSelectionDisplay.textContent = 'No files selected';
    } else if (count === 1) {
      const fileName = checkboxes[0].getAttribute('data-name');
      logFileSelectionDisplay.textContent = fileName;
    } else {
      logFileSelectionDisplay.textContent = `${count} files selected`;
    }
  }

  // Toggle dropdown
  logFileDropdownBtn?.addEventListener('click', (e) => {
    e.stopPropagation();

    if (logFileDropdownPanel.classList.contains('hidden')) {
      logFileSearch.value = '';
      // Show all items
      document.querySelectorAll('.log-file-item').forEach(item => { item.style.display = 'flex'; });
      // below the button, in the pane's viewport, the search field focused (diagPopover)
      window.diagPopover.open(logFileDropdownPanel, logFileDropdownBtn, { maxHeight: 480, minHeight: 220, focus: logFileSearch });
    } else {
      logFileDropdownPanel.classList.add('hidden');
    }
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!logFileDropdownPanel.contains(e.target) && !logFileDropdownBtn.contains(e.target)) {
      logFileDropdownPanel.classList.add('hidden');
    }
  });

  // Prevent dropdown from closing when clicking inside
  logFileDropdownPanel?.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Log file search functionality
  logFileSearch?.addEventListener('input', () => {
    const searchTerm = logFileSearch.value.toLowerCase();
    const items = document.querySelectorAll('.log-file-item');

    items.forEach(item => {
      const logName = item.getAttribute('data-log-name');
      if (logName.includes(searchTerm)) {
        item.style.display = 'flex';
      } else {
        item.style.display = 'none';
      }
    });
  });

  // Update display when checkboxes change
  document.querySelectorAll('.log-file-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', updateSelectionDisplay);
  });

  // Select All button
  selectAllLogsBtn?.addEventListener('click', () => {
    const visibleCheckboxes = Array.from(document.querySelectorAll('.log-file-item'))
      .filter(item => item.style.display !== 'none')
      .map(item => item.querySelector('.log-file-checkbox'));

    visibleCheckboxes.forEach(cb => cb.checked = true);
    updateSelectionDisplay();
  });

  // Clear All button
  clearAllLogsBtn?.addEventListener('click', () => {
    document.querySelectorAll('.log-file-checkbox').forEach(cb => cb.checked = false);
    updateSelectionDisplay();
  });

  // Initialize display
  updateSelectionDisplay();

  // Date range from server - parse as UTC to avoid timezone issues.
  // null (not a string) when no readable log had a parseable timestamp.
  const minDateStr = adapter.dateRange && adapter.dateRange.start || null;
  const maxDateStr = adapter.dateRange && adapter.dateRange.end || null;

  // Helper to check if timestamp has timezone info (Z, +00:00, -05:00, etc.)
  const hasTimezone = (str) => str.includes('Z') || str.includes('+') || str.match(/-\d{2}:\d{2}$/);

  // Parse an ISO string as UTC; null/unparseable -> null.
  // Handle both 'Z' and '+00:00' timezone formats
  const parseServerDate = (str) => {
    if (typeof str !== 'string' || !str) return null;
    const d = new Date(hasTimezone(str) ? str : str + 'Z');
    return isNaN(d.getTime()) ? null : d;
  };
  const midnightUTC = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));

  let minDateParsed = parseServerDate(minDateStr);
  let maxDateParsed = parseServerDate(maxDateStr);

  // Whether the slider bounds are real. When false the labels read "unknown",
  // the slider is a single point (today) and Load Logs asks for a range first.
  let dateRangeKnown = !!(minDateParsed && maxDateParsed);
  // the sources carry no timestamps (the adapter's date range said so): they load whole, in file order; the empty
  // ones are named apart; loadsWhole: the selection needs no date range (undated or empty throughout)
  let untimestamped = [];
  let emptySources = [];
  let loadsWhole = false;
  if (!dateRangeKnown) {
    // no bounds known: the report's own time (the adapter's gatherTime) stands in, never today
    minDateParsed = parseServerDate(adapter.gatherTime) || new Date();
    maxDateParsed = minDateParsed;
  }

  // Normalize to midnight UTC
  let minDate = midnightUTC(minDateParsed);
  let maxDate = midnightUTC(maxDateParsed);
  let totalDays = Math.max(0, Math.ceil((maxDate - minDate) / (1000 * 60 * 60 * 24)));


  // Initialize date sliders (a report without logs has none: the Findings strip says so)
  if (dateSliderStart && dateSliderEnd) {
  dateSliderStart.min = 0;
  dateSliderStart.max = totalDays;
  dateSliderStart.value = 0;
  dateSliderEnd.min = 0;
  dateSliderEnd.max = totalDays;
  dateSliderEnd.value = totalDays;
  }

  // the note under the slider for sources without timestamps, and the slider shown only when a range applies
  function rangeNote(selectedCount) {
    const note = document.getElementById('date-range-note');
    if (!note) return;
    if (!untimestamped.length) {
      const allEmpty = emptySources.length > 0 && emptySources.length >= selectedCount;
      note.textContent = allEmpty ? (selectedCount === 1 ? 'This log is empty.' : 'The selected logs are empty.') : '';
      note.hidden = !allEmpty;
      return;
    }
    const all = untimestamped.length + emptySources.length >= selectedCount;
    note.textContent = all
      ? (untimestamped.length === 1 ? 'This log carries no timestamps; it loads in file order.' : 'These logs carry no timestamps; they load in file order.')
      : `${untimestamped.length} of ${selectedCount} selected logs carry no timestamps (${untimestamped.slice(0, 3).join(', ')}${untimestamped.length > 3 ? ', …' : ''}); they load in file order, the date range applies to the rest.`;
    note.hidden = false;
  }
  function sliderShown(on) {
    const slider = document.querySelector('.lv-slider');
    if (slider) slider.hidden = !on;
    if (singleDateButton) singleDateButton.hidden = !on;
  }
  function updateDateLabel() {
    if (!dateSliderStart || !dateSliderEnd) return;   // no logs, no date picker
    const startDays = parseInt(dateSliderStart.value);
    const endDays = parseInt(dateSliderEnd.value);


    // Create dates in UTC to avoid timezone shifting
    const startDate = new Date(Date.UTC(
      minDate.getUTCFullYear(),
      minDate.getUTCMonth(),
      minDate.getUTCDate() + startDays,
      0, 0, 0, 0
    ));

    const endDate = new Date(Date.UTC(
      minDate.getUTCFullYear(),
      minDate.getUTCMonth(),
      minDate.getUTCDate() + endDays,
      0, 0, 0, 0
    ));


    if (dateRangeKnown) {
      dateStartLabel.textContent = startDate.toISOString().split('T')[0];
      dateEndLabel.textContent = endDate.toISOString().split('T')[0];
    } else {
      dateStartLabel.textContent = 'unknown';
      dateEndLabel.textContent = 'unknown';
    }

    // Update visual range highlight (max is 0 for a single-day/unknown range)
    const max = parseInt(dateSliderStart.max) || 1;
    const startPercent = (startDays / max) * 100;
    const endPercent = (endDays / max) * 100;

    dateRangeHighlight.style.left = `${startPercent}%`;
    dateRangeHighlight.style.width = `${endPercent - startPercent}%`;

    // Update calendar picker's selected range
    rangeStartDate = startDate;
    rangeEndDate = endDate;

    // Update the calendar picker display text
    singleDateDisplay.textContent = formatDateDisplay();

    // the calendar follows the slider
    if (picker) picker.set(rangeStartDate, rangeEndDate);
  }

  // Dual slider interaction handler
  function setupDualSlider(container, startSlider, endSlider, updateCallback) {
    if (!container || !startSlider || !endSlider) return;   // no logs, no slider
    let activeSlider = null;
    let isDragging = false;

    function updateSliderFromMouse(e) {
      if (!isDragging || !activeSlider) return;

      const rect = container.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const percent = Math.max(0, Math.min(1, clickX / rect.width));
      const clickValue = percent * (parseInt(activeSlider.max) - parseInt(activeSlider.min)) + parseInt(activeSlider.min);

      activeSlider.value = Math.round(clickValue);

      // Constrain values
      if (activeSlider === startSlider) {
        if (parseInt(startSlider.value) > parseInt(endSlider.value)) {
          startSlider.value = endSlider.value;
        }
      } else {
        if (parseInt(endSlider.value) < parseInt(startSlider.value)) {
          endSlider.value = startSlider.value;
        }
      }

      updateCallback();
    }

    container.addEventListener('mousedown', (e) => {
      const rect = container.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const percent = clickX / rect.width;
      const clickValue = percent * (parseInt(startSlider.max) - parseInt(startSlider.min)) + parseInt(startSlider.min);

      const startValue = parseInt(startSlider.value);
      const endValue = parseInt(endSlider.value);

      // Determine which handle is closer
      const distToStart = Math.abs(clickValue - startValue);
      const distToEnd = Math.abs(clickValue - endValue);

      if (distToStart <= distToEnd) {
        activeSlider = startSlider;
        startSlider.style.pointerEvents = 'auto';
        endSlider.style.pointerEvents = 'none';
        startSlider.style.zIndex = '2';
        endSlider.style.zIndex = '1';
      } else {
        activeSlider = endSlider;
        endSlider.style.pointerEvents = 'auto';
        startSlider.style.pointerEvents = 'none';
        endSlider.style.zIndex = '2';
        startSlider.style.zIndex = '1';
      }

      isDragging = true;
      updateSliderFromMouse(e);
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        updateSliderFromMouse(e);
      }
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        startSlider.style.pointerEvents = 'none';
        endSlider.style.pointerEvents = 'none';
        activeSlider = null;
      }
    });

    startSlider.addEventListener('input', () => {
      if (parseInt(startSlider.value) > parseInt(endSlider.value)) {
        startSlider.value = endSlider.value;
      }
      updateCallback();
    });

    endSlider.addEventListener('input', () => {
      if (parseInt(endSlider.value) < parseInt(startSlider.value)) {
        endSlider.value = startSlider.value;
      }
      updateCallback();
    });
  }

  setupDualSlider(document.getElementById('date-slider-container'), dateSliderStart, dateSliderEnd, updateDateLabel);

  // Custom date picker - range selection (use UTC dates)
  let rangeStartDate = null;
  let rangeEndDate = null;
  let picker = null;   // the shared date-range picker (diagDateRange) on the calendar

  function formatDateDisplay() {
    if (!rangeStartDate && !rangeEndDate) return 'Select Range';
    if (rangeStartDate && !rangeEndDate) {
      return `${rangeStartDate.getUTCFullYear()}-${String(rangeStartDate.getUTCMonth() + 1).padStart(2, '0')}-${String(rangeStartDate.getUTCDate()).padStart(2, '0')}`;
    }
    if (rangeStartDate && rangeEndDate) {
      const startStr = `${rangeStartDate.getUTCFullYear()}-${String(rangeStartDate.getUTCMonth() + 1).padStart(2, '0')}-${String(rangeStartDate.getUTCDate()).padStart(2, '0')}`;
      const endStr = `${rangeEndDate.getUTCFullYear()}-${String(rangeEndDate.getUTCMonth() + 1).padStart(2, '0')}-${String(rangeEndDate.getUTCDate()).padStart(2, '0')}`;
      if (rangeStartDate.getTime() === rangeEndDate.getTime()) {
        return startStr;
      }
      return `${startStr} - ${endStr}`;
    }
    return 'Select Range';
  }

  // the calendar: the shared picker on the slider's bounds. A complete pick (start and end) moves the slider; the
  // slider's moves show in the calendar (updateDateLabel); Clear resets the label only; Escape closes
  if (dateCalendar && window.diagDateRange) {
    picker = window.diagDateRange.mount(dateCalendar, {
      min: minDate, max: maxDate, start: rangeStartDate, end: rangeEndDate,
      onChange(start, end, done) {
        rangeStartDate = start; rangeEndDate = end;
        singleDateDisplay.textContent = formatDateDisplay();
        if (done && start && end && dateSliderStart && dateSliderEnd) {
          const day = 1000 * 60 * 60 * 24;
          dateSliderStart.value = Math.max(0, Math.floor((start - minDate) / day));
          dateSliderEnd.value = Math.max(0, Math.floor((end - minDate) / day));
          updateDateLabel();
        }
      },
      onClear() { rangeStartDate = null; rangeEndDate = null; singleDateDisplay.textContent = 'Select Range'; window.diagPopover.close(dateCalendar); },
      onClose() { window.diagPopover.close(dateCalendar); singleDateButton?.focus(); },
    });
  }

  singleDateButton?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.diagPopover.isOpen(dateCalendar)) { window.diagPopover.close(dateCalendar); return; }
    if (picker) picker.set(rangeStartDate, rangeEndDate).view(rangeStartDate || maxDate);
    // beside its button, in the pane's viewport (the calendar is a fixed-height grid: it flips above when it must)
    window.diagPopover.open(dateCalendar, singleDateButton, { maxHeight: 480, minHeight: 'natural', align: 'right' });
    if (picker) picker.focus();
  });

  // Prevent calendar clicks from closing it
  dateCalendar?.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Escape closes whichever popover is open (the calendar's own keys handle it while a day has the focus)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (dateCalendar && window.diagPopover.isOpen(dateCalendar)) { window.diagPopover.close(dateCalendar); singleDateButton?.focus(); }
    if (logFileDropdownPanel && !logFileDropdownPanel.classList.contains('hidden')) { logFileDropdownPanel.classList.add('hidden'); logFileDropdownBtn?.focus(); }
  });

  // Close calendar on outside click
  document.addEventListener('click', (e) => {
    if (!dateCalendar.contains(e.target) && !singleDateButton.contains(e.target)) {
      dateCalendar.classList.add('hidden');
    }
  });

  updateDateLabel();

  // Initialize empty charts
  updateProcessChart([]);
  updateSeverityChart([]);

  // Helper to truncate long strings with middle ellipsis
  function truncateMiddle(str, maxLength = 30) {
    if (str.length <= maxLength) return str;
    const partLength = Math.floor((maxLength - 3) / 2);
    return str.substring(0, partLength) + '...' + str.substring(str.length - partLength);
  }

  function updateProcessChart(entries) {
    // the rows by their group (the adapter's: a container, a host service, a node; else the process), the 15 largest
    const counts = new Map();
    entries.forEach(entry => {
      const g = groupOf(entry);
      if (!g.key) return;
      const c = counts.get(g.key) || { g, n: 0 };
      c.n += 1;
      counts.set(g.key, c);
    });
    const sortedProcesses = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 15);

    const processCard = document.getElementById('processChart') && document.getElementById('processChart').closest('[data-chart-card]');
    if (processCard) processCard.hidden = sortedProcesses.length === 0;   // no logs loaded: no chart card (the strip says what to do)
    if (sortedProcesses.length === 0) return;
    const fullNames = sortedProcesses.map(c => c.g.title || c.g.label);
    const keys = sortedProcesses.map(c => c.g.key);

    // Truncate labels for display
    const labels = sortedProcesses.map(c => truncateMiddle(c.g.label, 30));
    const data = sortedProcesses.map(c => c.n);

    const config = {
      type: 'bar',
      // a bar picks its source in the select (the shared click resolver hands the exact key)
      onPick: (p) => { if (!processFilter) return; processFilter.value = processFilter.value === p.key ? '' : p.key; processFilter.dispatchEvent(new Event('change', { bubbles: true })); },
      data: {
        labels,
        keys,
        datasets: [{
          label: 'Log Count',
          data,
          backgroundColor: 'rgba(59, 130, 246, 0.6)',
          borderColor: 'rgba(59, 130, 246, 1)',
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              // Show full process name in tooltip
              title: (ctx) => fullNames[ctx[0].dataIndex],
              label: ctx => ` ${ctx.raw} logs`
            }
          }
        },
        scales: {
          x: {
            ticks: {
              color: window.diagnosticsThemeColor('text'),
              maxRotation: 45,
              minRotation: 45
            },
            grid: { color: window.diagnosticsThemeColor('grid') }
          },
          y: {
            beginAtZero: true,
            ticks: { color: window.diagnosticsThemeColor('text') },
            grid: { color: window.diagnosticsThemeColor('grid') }
          }
        }
      }
    };

    const ctx = document.getElementById('processChart'); if (!ctx) return;
    if (processChart) {
      processChart.destroy();
    }
    processChart = window.diagChart.make(ctx, config);
  }

  function updateSeverityChart(entries) {
    const severityCounts = {
      critical: 0,
      error: 0,
      warning: 0,
      info: 0,
      debug: 0,
      other: 0
    };

    entries.forEach(entry => {
      if (entry.severity && Object.prototype.hasOwnProperty.call(severityCounts, entry.severity)) {
        severityCounts[entry.severity]++;
      }
    });

    const severityCard = document.getElementById('severityChart') && document.getElementById('severityChart').closest('[data-chart-card]');
    if (severityCard) severityCard.hidden = entries.length === 0;
    if (entries.length === 0) return;
    const labels = Object.keys(severityCounts);
    const data = Object.values(severityCounts);

    // the severities in the badge colours (critical / error = bad, warning = the warn token the WARN badge uses,
    // info = the accent, debug / other muted), the count on each bar, a click filters the table to that level
    const config = {
      type: 'bar',
      valueLabels: true,
      // a click on a bar: the shared resolver hands the level (data.keys) beside the shown label, and toggles the filter
      onPick: (p) => { if (!severityFilter) return; severityFilter.value = severityFilter.value === p.key ? '' : p.key; severityFilter.dispatchEvent(new Event('change', { bubbles: true })); },
      data: {
        labels: labels.map(l => l.charAt(0).toUpperCase() + l.slice(1)),
        keys: labels.slice(),
        datasets: [{
          label: 'Log Count',
          data,
          roles: labels.map((l) => ({ critical: 'bad', error: 'bad', warning: 'warn', info: 'info', debug: 'muted', other: 'muted' })[l] || 'muted'),
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.raw} logs`,
              afterBody: () => ['click: filter to this level']
            }
          }
        },
        scales: {
          x: {
            ticks: { color: window.diagnosticsThemeColor('text') },
            grid: { color: window.diagnosticsThemeColor('grid') }
          },
          y: {
            beginAtZero: true,
            ticks: { color: window.diagnosticsThemeColor('text') },
            grid: { color: window.diagnosticsThemeColor('grid') }
          }
        }
      }
    };

    const ctx = document.getElementById('severityChart'); if (!ctx) return;
    if (severityChart) {
      severityChart.destroy();
    }
    severityChart = window.diagChart.make(ctx, config);
  }

  // Get Range button handler
  getRangeBtn?.addEventListener('click', () => { getRange(); });
  async function getRange() {
    const checkboxes = document.querySelectorAll('.log-file-checkbox:checked');
    const selectedPaths = Array.from(checkboxes).map(cb => cb.getAttribute('data-path'));

    if (selectedPaths.length === 0) {
      showAlert('No Files Selected', 'Please select at least one log file', 'warning');
      return;
    }

    const rangeBusy = window.diagBusy ? window.diagBusy.start(getRangeBtn, { label: 'Getting range…', bar: document.querySelector('.lv-toolbar') || document.querySelector('.lv-header') }) : null;
    if (!rangeBusy) { getRangeBtn.disabled = true; getRangeBtn.textContent = 'Getting range…'; }

    try {
      // the adapter reads the earliest and latest timestamps of the selected sources ({ start, end,
      // untimestamped: [names] }); sources without timestamps are not an error: they load whole, in file order
      const newRange = (await adapter.getRange(selectedPaths)) || {};
      const newMin = parseServerDate(newRange.start);
      const newMax = parseServerDate(newRange.end);
      untimestamped = Array.isArray(newRange.untimestamped) ? newRange.untimestamped : [];
      emptySources = Array.isArray(newRange.empty) ? newRange.empty : [];
      loadsWhole = !newMin && !newMax && (untimestamped.length > 0 || emptySources.length >= selectedPaths.length);
      rangeNote(selectedPaths.length);
      if (!newMin || !newMax) {
        if (loadsWhole) { dateRangeKnown = false; sliderShown(false); return; }
        throw new Error('Could not extract date range from selected files.');
      }
      loadsWhole = false;
      sliderShown(true);
      minDateParsed = newMin;
      maxDateParsed = newMax;
      dateRangeKnown = true;

      minDate = midnightUTC(minDateParsed);
      maxDate = midnightUTC(maxDateParsed);
      totalDays = Math.max(0, Math.ceil((maxDate - minDate) / (1000 * 60 * 60 * 24)));


      // Update slider limits and values
      dateSliderStart.max = totalDays;
      dateSliderEnd.max = totalDays;
      dateSliderStart.value = 0;
      dateSliderEnd.value = totalDays;

      if (picker) picker.bounds(minDate, maxDate);
      updateDateLabel();

    } catch (error) {
      console.error('[Get Range] Error:', error);

      // the bounds stay what they were (never reset to today); the message says what failed
      showAlert('Error Getting Date Range', error.message, 'error');
    } finally {
      if (rangeBusy) rangeBusy.done('Date range read'); else { getRangeBtn.disabled = false; getRangeBtn.textContent = 'Get Date Range'; }
    }
  }

  // a cross-link's source list (see the contract above): the sources it names checked and nothing else, their date
  // range read, the logs loaded, the term in the search; false when the query is not a source list
  function applyQuery(q) {
    const m = /^sources=([^&]*)(?:&q=(.*))?$/.exec(String(q || ''));
    if (!m) return false;
    const wanted = decodeURIComponent(m[1]).split(',').map((s) => s.trim()).filter(Boolean);
    const hit = (box, w) => {
      const d = box.dataset;
      if (w.startsWith('node:')) return d.type === 'node' && d.node === w.slice(5);
      if (w.startsWith('host:')) { const [role, file] = w.slice(5).split('/'); return d.type === 'host' && d.role === role && (!file || d.name === `${role}/${file}`); }
      if (d.type === 'container') { const parts = w.split('/'); return d.namespace === parts[0] && d.pod === parts[1] && (parts.length < 3 || d.container === parts[2]); }
      return d.name === w;
    };
    let n = 0;
    document.querySelectorAll('.log-file-checkbox').forEach((box) => { const on = wanted.some((w) => hit(box, w)); box.checked = on; if (on) n += 1; });
    updateSelectionDisplay();
    if (searchInput) { searchInput.value = m[2] ? decodeURIComponent(m[2]) : ''; }
    if (!n) { showAlert('No Matching Logs', `None of the listed logs is ${wanted.join(', ')}.`, 'warning'); return true; }
    (async () => { await getRange(); if (!isLoading) await loadLogs(); })();
    return true;
  }

  async function loadLogs() {
    // Collect selected log file paths
    const checkboxes = document.querySelectorAll('.log-file-checkbox:checked');
    const selectedPaths = Array.from(checkboxes).map(cb => cb.getAttribute('data-path'));

    if (selectedPaths.length === 0) {
      showAlert('No Files Selected', 'Please select at least one log file', 'warning');
      return;
    }

    if (!dateRangeKnown && !loadsWhole) {
      showAlert('Date Range Unknown',
        'No timestamps could be read from the default log files. Select the log files to view and click "Get Date Range" first.',
        'warning');
      return;
    }

    // Calculate start and end datetime from date slider (full days)
    const startDays = parseInt(dateSliderStart.value);
    const endDays = parseInt(dateSliderEnd.value);

    // Create dates in UTC to avoid timezone shifting
    const startDate = new Date(Date.UTC(
      minDate.getUTCFullYear(),
      minDate.getUTCMonth(),
      minDate.getUTCDate() + startDays,
      0, 0, 0, 0
    ));

    const endDate = new Date(Date.UTC(
      minDate.getUTCFullYear(),
      minDate.getUTCMonth(),
      minDate.getUTCDate() + endDays,
      23, 59, 59, 999
    ));

    // no known range (the sources carry no timestamps): the sources load whole, in file order
    const startDateStr = dateRangeKnown ? startDate.toISOString().slice(0, 16) : '';
    const endDateStr = dateRangeKnown ? endDate.toISOString().slice(0, 16) : '';

    isLoading = true;
    loadLogsBtn.textContent = 'Abort Loading';
    loadLogsBtn.classList.add('btn-danger-solid'); loadLogsBtn.classList.remove('btn-primary');
    loadingIndicator?.classList.remove('hidden');
    loadingIndicator.textContent = 'Loading logs…';
    if (busyHandle) busyHandle.done('');
    busyHandle = window.diagBusy ? window.diagBusy.start(null, { label: 'Loading logs…', table: document.getElementById('log-table-container'), bar: document.querySelector('.lv-toolbar') || document.querySelector('.lv-header'), cancel: abortLoading }) : null;
    logsLoadedInfo?.classList.add('hidden');

    // Reset state
    allEntries = [];
    filteredEntries = [];

    try {
      // the adapter reads the selected sources for the selected dates and hands the rows over as they come
      // (sosreport: the streamed journal parse; must-gather: the server-side search, page by page); the filters as
      // set apply to what has arrived, and the handle's cancel() aborts mid-way
      // the progress, the same for both adapters: the entries so far and the files done, in the status line and on
      // the busy pill (with Cancel), after every page or chunk - rows or not
      const progress = (p) => {
        const files = p.filesTotal ? ` (${Number(p.filesDone || 0).toLocaleString()} of ${Number(p.filesTotal).toLocaleString()} files)` : '';
        const text = `Loading logs… ${Number(p.entries || allEntries.length).toLocaleString()} entries${files}`;
        if (loadingIndicator) loadingIndicator.textContent = text;
        if (busyHandle) busyHandle.update(text);
      };
      // the filters as set go with the load: the adapter applies them while scanning, so what arrives is the matches
      // across every selected file (the fields keep refining the loaded rows afterwards)
      const filters = {
        search: parseCommaSeparated(searchInput?.value?.trim() || ''), exclude: parseCommaSeparated(document.getElementById('log-exclude')?.value?.trim() || ''),
        level: severityFilter?.value || '', source: processFilter?.value || '',
      };
      loadScope = { filtered: !!(filters.search.length || filters.exclude.length || filters.level || filters.source), files: selectedPaths.length };
      const stream = adapter.load({ paths: selectedPaths, start: startDateStr, end: endDateStr, ...filters }, (entries, totalCount) => {
        if (!entries || !entries.length) return;
        allEntries.push(...entries);
        applyFilters();
        if (loadedCount) {
          // "N / total" only when the adapter knows the total ahead (the stream's total_count); a page count is just N
          const known = totalCount && totalCount > allEntries.length;
          loadedCount.textContent = known ? `Loaded ${allEntries.length.toLocaleString()} / ${totalCount.toLocaleString()} entries` : `Loaded ${allEntries.length.toLocaleString()} entries…`;
          logsLoadedInfo?.classList.remove('hidden');
        }
      }, progress);
      currentReader = stream;   // the handle exposes .cancel() for abortLoading()
      await stream.done;
      // the final render: the filters as set apply to the new rows (table, counts, export)
      applyFilters();
      if (loadedCount) loadedCount.textContent = `Loaded ${allEntries.length.toLocaleString()} entries`;
    } catch (error) {
      console.error('Error loading logs:', error);
      if (error.name !== 'AbortError') {
        showAlert('Error Loading Logs', error.message, 'error');
      }
    } finally {
      isLoading = false;
      currentReader = null;
      loadLogsBtn.textContent = 'Load Logs';
      loadLogsBtn.classList.remove('btn-danger-solid'); loadLogsBtn.classList.add('btn-primary');
      loadingIndicator?.classList.add('hidden');
      if (busyHandle) { busyHandle.done(allEntries.length ? `${allEntries.length.toLocaleString()} entries loaded` : 'No entries'); busyHandle = null; }
    }
  }

  function abortLoading() {
    if (currentReader) {
      currentReader.cancel();
      currentReader = null;
      isLoading = false;
      loadLogsBtn.textContent = 'Load Logs';
      loadLogsBtn.classList.remove('btn-danger-solid'); loadLogsBtn.classList.add('btn-primary');
      loadingIndicator?.classList.add('hidden');
      if (busyHandle) { busyHandle.cancel(); busyHandle = null; }

      if (allEntries.length > 0) {
        // the filters as set apply to what was loaded before the abort
        applyFilters();

        if (loadedCount) {
          loadedCount.textContent = `Loaded ${allEntries.length.toLocaleString()} entries (aborted)`;
          logsLoadedInfo?.classList.remove('hidden');
        }
      }
    }
  }

  // Helper function to parse comma-separated values with quote support
  // The terms of a filter field: comma-separated, a row matches ANY of them.
  // A phrase with commas or spaces goes in quotes - the quote counts only at
  // the START of a term, so an apostrophe inside a word ("can't reach") is
  // text, not a quote. A backslash escapes a quote, a comma or a backslash;
  // before anything else it is text (C:\temp stays C:\temp). Terms are
  // trimmed, empty ones (a trailing comma) dropped, and lower-cased: the
  // matching is case-insensitive.
  function parseCommaSeparated(input) {
    if (!input || !input.trim()) return [];

    const terms = [];
    let current = '';
    let atTermStart = true;
    let quoteChar = null;

    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      const next = input[i + 1];

      if (char === '\\' && (next === '"' || next === "'" || next === ',' || next === '\\')) {
        current += next;
        i++;
        atTermStart = false;
      } else if (quoteChar) {
        if (char === quoteChar) quoteChar = null;
        else current += char;
      } else if ((char === '"' || char === "'") && atTermStart) {
        quoteChar = char;
        atTermStart = false;
      } else if (char === ',') {
        const term = current.trim();
        if (term) terms.push(term);
        current = '';
        atTermStart = true;
      } else {
        current += char;
        if (!/\s/.test(char)) atTermStart = false;
      }
    }

    const term = current.trim();
    if (term) terms.push(term);

    return terms.map(t => t.toLowerCase());
  }

  function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  // The text a row is matched against: every column, lower-cased, computed
  // once per entry (not once per term per keystroke).
  // the group a row belongs to (the adapter's, else its process): the source chart's bars and the select's options
  function groupOf(entry) {
    if (!entry._g) entry._g = adapter.group ? adapter.group(entry) : { key: entry.process || '', label: entry.process || '', title: entry.process || '' };
    return entry._g;
  }

  function searchableText(entry) {
    if (entry._text === undefined) {
      entry._text = [
        entry.timestamp || '',
        entry.severity || '',
        entry.hostname || '',
        entry.process || '',
        entry.pid || '',
        entry.message || ''
      ].join(' ').toLowerCase();
    }
    return entry._text;
  }

  // Typing is debounced: the filter runs once the keys pause, not per key.
  function debounce(fn, ms) {
    let timer = null;
    const run = () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
    run.now = () => { clearTimeout(timer); fn(); };
    return run;
  }

  const SEVERITY_LEVELS = ['critical', 'error', 'warning', 'info', 'debug', 'other'];

  function applyFilters() {
    const searchQuery = searchInput?.value?.trim() || '';
    const excludeQuery = document.getElementById('log-exclude')?.value?.trim() || '';
    const severity = severityFilter?.value || '';
    const process = processFilter?.value || '';

    // Parse search filters (comma-separated list with quote support - OR matching)
    const searchTerms = parseCommaSeparated(searchQuery);
    // Parse exclusion filters (comma-separated list with quote support)
    const excludeTerms = parseCommaSeparated(excludeQuery);

    // Stage 1: the level (the process list below follows it)
    const byLevel = severity ? allEntries.filter(entry => entry.severity === severity) : allEntries;

    // Stage 2: the process, then the text filters
    filteredEntries = byLevel.filter(entry => {
      if (process && groupOf(entry).key !== process) return false;
      if (searchTerms.length === 0 && excludeTerms.length === 0) return true;
      const text = searchableText(entry);
      // Search across all columns (inclusion) - match ANY search term (OR logic)
      if (searchTerms.length > 0 && !searchTerms.some(term => text.includes(term))) return false;
      // Exclusion filter - if any exclude term matches, exclude this entry
      if (excludeTerms.length > 0 && excludeTerms.some(term => text.includes(term))) return false;
      return true;
    });

    // The selects: every level is always offered (a level with no rows shows
    // "No entries", and can be left again directly); the processes are those
    // of the rows of the chosen level, so changing the level keeps the list
    // honest. Typing in the text filters does not touch the lists.
    if (severityFilter && severityFilter.options.length !== SEVERITY_LEVELS.length + 1) {
      severityFilter.innerHTML = '<option value="">All Levels</option>' +
        SEVERITY_LEVELS.map(sev => `<option value="${sev}">${sev === 'info' ? 'Information' : sev.charAt(0).toUpperCase() + sev.slice(1)}</option>`).join('');
      severityFilter.value = severity;
    }
    if (processFilter) {
      const groups = new Map();
      byLevel.forEach((entry) => { const g = groupOf(entry); if (g.key && !groups.has(g.key)) groups.set(g.key, g); });
      const sortedGroups = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
      const listed = [...processFilter.options].slice(1).map(option => option.value);
      if (listed.length !== sortedGroups.length || listed.some((key, i) => key !== sortedGroups[i].key)) {
        processFilter.innerHTML = `<option value="">${escapeHtml(adapter.sourceLabel || 'All Processes')}</option>` +
          sortedGroups.map(g => `<option value="${escapeHtml(g.key)}" title="${escapeHtml(g.title || g.label)}">${escapeHtml(g.label)}</option>`).join('');
        processFilter.value = groups.has(process) ? process : '';
      }
    }

    // Update charts based on filtered data
    // (the update functions create the charts on their first call)
    if (allEntries.length > 0) {
      updateSeverityChart(filteredEntries);
      updateProcessChart(filteredEntries);
    }

    // Enable/disable export button based on filtered data
    const exportCsvBtn = document.getElementById('export-csv-btn');
    if (exportCsvBtn) {
      exportCsvBtn.disabled = filteredEntries.length === 0;
    }

    currentPage = 0;
    renderTable();
  }

  function renderTable() {
    if (!logTableBody) return;

    const start = pageSize === -1 ? 0 : currentPage * pageSize;
    const end = pageSize === -1 ? filteredEntries.length : start + pageSize;
    const pageEntries = filteredEntries.slice(start, end);

    if (filteredEntries.length === 0) {
      logTableBody.innerHTML = '';
      noResults?.classList.remove('hidden');
      // the scope again: a filtered load that matched nothing, the filters typed since emptying its matches, or a plain load's rows
      const files = loadScope ? `${loadScope.files.toLocaleString()} file${loadScope.files === 1 ? '' : 's'}` : '';
      const none = loadScope && loadScope.filtered
        ? (allEntries.length ? `No entries in the ${allEntries.length.toLocaleString()} match${allEntries.length === 1 ? '' : 'es'} across all ${files}` : `No matches across all ${files}`)
        : (allEntries.length ? `No entries in the loaded ${allEntries.length.toLocaleString()}` : 'No entries');
      // a filter typed (or handed over by a cross-link) before any log is loaded: the counters are not on the page yet
      if (entryCount) entryCount.textContent = none;
      const top = document.getElementById('entry-count-top');
      if (top) top.textContent = none;
      if (pageInfo) pageInfo.textContent = '';
      return;
    }

    noResults?.classList.add('hidden');

    logTableBody.innerHTML = pageEntries.map((entry) => {
      // Escape HTML to prevent injection
      const escapedMessage = entry.message
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

      const processDisplay = entry.pid ? `${entry.process}[${entry.pid}]` : entry.process;

      return `
        <tr data-severity="${entry.severity}">
          <td class="ui-mono align-top">${entry.timestamp}</td>
          <td class="align-top">
            <span class="ui-badge ui-badge-${({critical: 'bad', error: 'bad', warning: 'warn', notice: 'info', info: 'info'})[entry.severity] || 'muted'} severity-badge severity-${entry.severity}">${entry.severity}</span>${(entry.badges || []).map((b) => ` <span class="ui-badge ui-badge-${b.kind || 'muted'}"${b.title ? ` title="${escapeHtml(b.title)}"` : ''}>${escapeHtml(b.text)}</span>`).join('')}
          </td>
          <td class="align-top opacity-70">${entry.hostname || ''}</td>
          <td class="align-top opacity-70 ui-mono">${processDisplay || ''}</td>
          <td class="ui-mono whitespace-pre-wrap" style="word-break: break-word;">${escapedMessage}</td>
        </tr>
      `;
    }).join('');

    // Update pagination info
    // the scope: a load with the filters applied server-side holds the matches across all the files; a plain load the
    // rows the fields keep of what was loaded
    const scope = loadScope && loadScope.filtered
      ? ` \u2014 ${allEntries.length.toLocaleString()} match${allEntries.length === 1 ? '' : 'es'} across all ${loadScope.files.toLocaleString()} file${loadScope.files === 1 ? '' : 's'}` + (filteredEntries.length < allEntries.length ? ` (${filteredEntries.length.toLocaleString()} after the filters typed since)` : '')
      : (filteredEntries.length < allEntries.length ? ` in the loaded ${allEntries.length.toLocaleString()}` : '');
    const showingText = `Showing ${(start + 1).toLocaleString()}-${Math.min(end, filteredEntries.length).toLocaleString()} of ${filteredEntries.length.toLocaleString()}` + scope;
    entryCount.textContent = showingText;
    document.getElementById('entry-count-top').textContent = showingText;
    updatePagination();
  }

  function updatePagination() {
    // the shared pager: 1-based pages for the reader, goToPage(n) takes the page number
    window.diagPager.render(document.getElementById('pagination-controls'), { total: filteredEntries.length, page: currentPage + 1, pageSize: pageSize, go: function (p) { window.goToPage(p); } });
  }

  window.sortTable = function(col) {
    if (sortColumn === col) {
      sortAscending = !sortAscending;
    } else {
      sortColumn = col;
      sortAscending = true;
    }

    // Clear all sort icons
    for (let i = 0; i < 4; i++) {
      const icon = document.getElementById(`sort-${i}`);
      if (icon) icon.className = 'fas fa-sort ml-1 opacity-50';
    }

    // Set current sort icon
    const icon = document.getElementById(`sort-${col}`);
    icon.className = `fas fa-sort-${sortAscending ? 'up' : 'down'} ml-1`;
    window.diagTables.markSort(icon, sortAscending);

    filteredEntries.sort((a, b) => {
      let valA, valB;
      if (col === 0) { // Timestamp - use timestamp_obj for proper chronological sorting
        valA = a.timestamp_obj || '';
        valB = b.timestamp_obj || '';
      } else if (col === 1) { // Severity
        valA = a.severity;
        valB = b.severity;
      } else if (col === 2) { // Hostname
        valA = a.hostname || '';
        valB = b.hostname || '';
      } else if (col === 3) { // Process
        valA = a.process || '';
        valB = b.process || '';
      }

      if (valA < valB) return sortAscending ? -1 : 1;
      if (valA > valB) return sortAscending ? 1 : -1;
      return 0;
    });

    renderTable();
  };

  window.changePageSize = function() {
    pageSize = parseInt(document.getElementById('page-size').value);
    currentPage = 0;
    renderTable();
  };

  window.goToPage = function(page) {
    currentPage = page - 1; // Convert to 0-indexed
    renderTable();
  };

  loadLogsBtn?.addEventListener('click', () => {
    if (isLoading) {
      abortLoading();
    } else {
      loadLogs();
    }
  });

  // Export CSV functionality
  const exportCsvBtn = document.getElementById('export-csv-btn');
  exportCsvBtn?.addEventListener('click', () => {
    if (filteredEntries.length === 0) {
      showAlert('No Data', 'No logs to export. Please load logs first.', 'warning');
      return;
    }

    // Build CSV content
    const headers = ['Timestamp', 'Level', 'Hostname', 'Process', 'PID', 'Message'];
    let csvContent = headers.map(h => `"${h}"`).join(',') + '\n';

    filteredEntries.forEach(entry => {
      const row = [
        entry.timestamp || '',
        entry.severity || '',
        entry.hostname || '',
        entry.process || '',
        entry.pid || '',
        (entry.message || '').replace(/"/g, '""') // Escape quotes in message
      ];
      csvContent += row.map(field => `"${field}"`).join(',') + '\n';
    });

    // Create download link
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;

    // Generate filename with date range
    let startDateStr = 'all';
    let endDateStr = 'all';

    if (rangeStartDate) {
      startDateStr = `${rangeStartDate.getUTCFullYear()}-${String(rangeStartDate.getUTCMonth() + 1).padStart(2, '0')}-${String(rangeStartDate.getUTCDate()).padStart(2, '0')}`;
    }
    if (rangeEndDate) {
      endDateStr = `${rangeEndDate.getUTCFullYear()}-${String(rangeEndDate.getUTCMonth() + 1).padStart(2, '0')}-${String(rangeEndDate.getUTCDate()).padStart(2, '0')}`;
    }

    const filename = `${adapter.exportPrefix || 'logs'}_${startDateStr}_to_${endDateStr}_${filteredEntries.length}entries.csv`;

    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showAlert('Export Complete', `Exported ${filteredEntries.length} log entries to ${filename}`, 'success');
  });

  const applyFiltersSoon = debounce(applyFilters, 150);
  searchInput?.addEventListener('input', applyFiltersSoon);
  document.getElementById('log-exclude')?.addEventListener('input', applyFiltersSoon);
  severityFilter?.addEventListener('change', applyFilters);
  processFilter?.addEventListener('change', applyFilters);
  const handle = { applyFilters, loadLogs, abortLoading, applyQuery, entries: () => allEntries, filtered: () => filteredEntries, root: root0 };
  mounted = handle;
  return handle;
}
let mounted = null;   // the one viewer of the page (diagLogView.applyQuery hands a cross-link to it)

  // a cross-link's source list for the page's viewer; it can arrive with the frame's first height report, before the
  // template's mount call ran, so it waits for the viewer (up to two seconds) rather than falling through to the
  // page's search field
  function applyQueryWhenMounted(q) {
    if (!/^sources=/.test(String(q || ''))) return false;
    var tries = 0;
    (function go() { if (mounted) { mounted.applyQuery(q); return; } if (tries++ < 40) setTimeout(go, 50); })();
    return true;
  }
  window.diagLogView = { mount: mount, adapters: adapters, sseReader: sseReader, applyQuery: applyQueryWhenMounted };
})();
