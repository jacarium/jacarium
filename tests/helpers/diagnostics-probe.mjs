/**
 * The component probes of the Diagnostics frame tests (tests/diagnostics-ui-consistency.test.mjs): every shared
 * component checked against its contract on every tab. Each probe runs inside the tab's frame and returns the
 * problems it found as short strings (an empty list = the tab is fine) plus the counts it looked at.
 *
 *   probeComponents(frame, { width })   charts (the height cap and box, radial types without axes, the legend
 *                                       swatches equal to the dataset colours, every category label present and
 *                                       not overlapping, the value axis with 3+ ticks, stacked segments distinct,
 *                                       the chart grid width), tables (the rounded bordered box, uniform row
 *                                       heights, one sort marker on a sortable table, non-sortable headers not
 *                                       clickable), pagers (one component: button heights, the current page,
 *                                       the disabled ends, hidden on one page), filter bars (one row, the width
 *                                       caps, uniform gaps, no stacked label, every control named), meters (a
 *                                       visible fill proportional to the value, the role of the Finding), chips
 *                                       (border, background, gap, the selected role, contrast, the dot), the
 *                                       Log Collection band (distinct segments, legend = segment), the Findings
 *                                       strip first with 1+ item, no empty-state block, the expandable rows'
 *                                       markup
 *   stability(frame)                    the chart canvases' heights now, for the "stable after resizes and theme
 *                                       toggles" comparison
 *   toggleDetails(frame)                clicks every details' summary (and toggles one by keyboard): open follows,
 *                                       the content is visible, the frame's document grows / shrinks
 *   exerciseXrows(frame)                opens the first expandable row by click and the second by keyboard, checks
 *                                       aria-expanded, the panel aligned to the first content column, Expand all /
 *                                       Collapse all
 *   exerciseSort(frame)                 clicks a second sortable header: the marker moves, the rows reorder
 *   exercisePager(frame)                page 2 through the shared pager: aria-current moves, the ends enable
 *   pagerShapes(frame)                  the shared pager drawn for 27,527 rows at page 1, 138 and 276 (the
 *                                       Log Viewer's numbers): the window shape, the go-to box
 */

export const probeComponents = (frame, opts) => frame.evaluate((opts) => {
  const width = document.documentElement.clientWidth;   // the frame's own width (the viewport the page sees)
  const root = document.querySelector('#diagnostics-content') || document.body;
  const out = { charts: [], tables: [], pagers: [], sorts: [], filters: [], meters: [], chips: [], band: [], findings: [], empty: [], xrows: [], n: {} };
  const n = (k) => { out.n[k] = (out.n[k] || 0) + 1; };
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const probe = document.createElement('div'); document.body.appendChild(probe);
  // a colour as rgba(): the computed value (oklch / color() tokens stay in their own syntax) is painted on a canvas and
  // the pixel read back, which handles every syntax the browser knows (tests/helpers/color.mjs does the same)
  const cvs = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const pixel = (c) => { if (!c || c === 'transparent' || c === 'none') return null; cvs.clearRect(0, 0, 1, 1); cvs.fillStyle = '#010203'; cvs.fillStyle = String(c); if (cvs.fillStyle === '#010203' && !/^#?0*10203$/i.test(String(c).replace(/\s/g, ''))) return null; cvs.fillRect(0, 0, 1, 1); const d = cvs.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; };
  const col = (v) => { probe.style.backgroundColor = ''; probe.style.backgroundColor = v; const p = pixel(getComputedStyle(probe).backgroundColor); return p ? 'rgba(' + p.r + ', ' + p.g + ', ' + p.b + ', ' + p.a.toFixed(3) + ')' : 'rgba(0, 0, 0, 0)'; };
  const tok = (t) => col(`var(${t})`);
  const parse = (c) => pixel(c);
  const dist = (a, b) => { const pa = parse(a), pb = parse(b); return (pa && pb) ? Math.abs(pa.r - pb.r) + Math.abs(pa.g - pb.g) + Math.abs(pa.b - pb.b) : 999; };
  const transparent = (c) => { const p = parse(c); return !p || p.a === 0; };
  const lum = (p) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(p.r) + 0.7152 * f(p.g) + 0.0722 * f(p.b); };
  const blend = (fg, bg) => { const a = fg.a; return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 }; };
  const contrast = (fgc, bgc, base) => { let fg = parse(fgc), bg = parse(bgc); if (!fg || !bg) return 21; if (bg.a < 1) bg = blend(bg, parse(base) || { r: 255, g: 255, b: 255, a: 1 }); if (fg.a < 1) fg = blend(fg, bg); const l1 = lum(fg), l2 = lum(bg); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const selectedBg = tok('--btn-selected-bg');
  const cardBg = tok('--os-card');
  const radiusTable = (() => { probe.style.borderRadius = 'var(--radius-table)'; const r = getComputedStyle(probe).borderTopLeftRadius; probe.style.borderRadius = ''; return r; })();

  // ---- the Findings strip first, with at least one item; no empty-state block anywhere ----
  let first = root;
  for (let i = 0; i < 12 && first && !first.matches('.ui-findings, .ui-note'); i++) { const kids = Array.from(first.children).filter((k) => vis(k) && !k.matches('script, style')); if (!kids.length) break; first = kids[0]; }
  const strip = root.querySelector('.ui-findings');
  const items = strip ? strip.querySelectorAll('.ui-finding').length : 0;
  n('findingsItems'); out.n.findingsItems = items;
  if (!strip) out.findings.push('no .ui-findings strip (' + (first && first.matches('.ui-note') ? 'a fallback note' : 'nothing') + ')');
  else if (!first || !first.matches('.ui-findings')) out.findings.push('the strip is not the first thing on the page: ' + (first ? name(first) : '?'));
  if (strip && items < 1) out.findings.push('the strip has no item');
  const EMPTY_RX = /No (\w+ )?Data Available|not available in this report|No [\w /-]+ (found|available) in this report|Nothing to size|No plugin timings in this/i;
  root.querySelectorAll('.ui-empty, .empty-state, .kd-empty, .lc-empty, .au-empty, .bl-empty, .ui-chart-empty, canvas').forEach((el) => {
    if (!vis(el)) return;
    if (el.tagName === 'CANVAS') { const c = window.Chart && window.Chart.getChart(el); if (!c || !(c.data.datasets || []).some((d) => (d.data || []).length)) out.empty.push('an empty canvas ' + name(el) + ' (' + Math.round(el.getBoundingClientRect().height) + 'px tall)'); return; }
    out.empty.push('an empty-state block ' + name(el));
  });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const s = t.textContent.trim(); if (!s || !EMPTY_RX.test(s)) continue;
    const el = t.parentElement; if (!el || !vis(el) || el.closest('.ui-findings, td.ui-match-none, script, style, option')) continue;
    out.empty.push('empty-state wording "' + s.slice(0, 50) + '" in ' + name(el));
  }
  // the Findings per severity (the meters compare against them)
  const findingsBy = { warn: [], bad: [] };
  if (strip) strip.querySelectorAll('.ui-finding').forEach((f) => { const sev = /ui-finding-bad/.test(f.className) ? 'bad' : /ui-finding-warn/.test(f.className) ? 'warn' : null; if (sev) findingsBy[sev].push((f.querySelector('.ui-finding-title') || f).textContent.toLowerCase()); });

  // ---- charts ----
  const charts = (window.Chart && window.Chart.instances ? Object.values(window.Chart.instances) : []).filter((c) => c.canvas && vis(c.canvas));
  charts.forEach((c) => {
    n('charts');
    const why = [];
    const canvas = c.canvas, box = canvas.parentElement, r = canvas.getBoundingClientRect(), type = c.config.type;
    const bcs = getComputedStyle(box);
    if (r.height > 482) why.push('taller than the cap: ' + Math.round(r.height));
    if (!/px$/.test(box.style.height || '') && !/px$/.test(box.style.maxHeight || '')) why.push('the box has no pixel height (' + (box.style.height || bcs.height) + ')');
    if (bcs.position !== 'relative') why.push('the box is not position: relative');
    const radial = /^(doughnut|pie|polarArea)$/.test(type);
    if (radial && Object.keys(c.scales || {}).length) why.push('a ' + type + ' with axes: ' + Object.keys(c.scales).join(','));
    if (radial && c.options.scales && Object.values(c.options.scales).some((s) => s && s.display !== false && (s.grid || {}).display !== false)) why.push('a ' + type + ' with grid options');
    // the legend: every swatch the colour of its dataset / slice
    const legend = c.options.plugins && c.options.plugins.legend;
    if (legend && legend.display !== false && c.legend && c.legend.legendItems) {
      c.legend.legendItems.forEach((it) => {
        const ds = radial ? c.data.datasets[0] : c.data.datasets[it.datasetIndex];
        if (!ds) return;
        let bg = ds.backgroundColor;
        if (typeof bg === 'function') { try { const m = c.getDatasetMeta(radial ? 0 : it.datasetIndex); const e = m && m.data && m.data[radial ? it.index : 0]; bg = e && e.options ? e.options.backgroundColor : null; } catch { bg = null; } }
        if (Array.isArray(bg)) bg = bg[radial ? it.index : 0];
        if (bg && it.fillStyle && typeof bg === 'string' && dist(col(bg), col(it.fillStyle)) > 12) why.push('legend swatch "' + it.text + '" ' + it.fillStyle + ' != dataset ' + bg);
        if (transparent(col(it.fillStyle))) why.push('legend swatch "' + it.text + '" transparent');
      });
    }
    // every category label present and readable; 3+ ticks on a value axis
    Object.entries(c.scales || {}).forEach(([k, s]) => {
      if (!s || !s.ticks) return;
      if (s.type === 'category') {
        const labels = c.data.labels || [];
        if (type === 'bar' && labels.length && labels.length < 64 && s.ticks.length !== labels.length) why.push(k + ': ' + s.ticks.length + ' of ' + labels.length + ' labels shown');
        if (type === 'bar' && labels.length >= 64 && s.ticks.length < (width >= 1360 ? 8 : 4)) why.push(k + ': only ' + s.ticks.length + ' labels for ' + labels.length + ' categories');
        const labelled = s.ticks.map((t, i) => ({ t, i })).filter((x) => String(x.t.label || '').trim() !== '');
        if (labelled.length > 1) {
          const sp = Math.abs(s.getPixelForTick(labelled[1].i) - s.getPixelForTick(labelled[0].i));
          const font = (s.options.ticks.font && s.options.ticks.font.size) || 11;
          const ctx = c.ctx; ctx.save(); ctx.font = font + 'px ' + ((s.options.ticks.font && s.options.ticks.font.family) || 'sans-serif');
          const horizontal = c.options.indexAxis === 'y';
          if (horizontal && k === 'y') { if (sp < font + 2) why.push('y labels overlap: ' + Math.round(sp) + 'px per row'); }
          else {
            const rot = s.labelRotation || 0;
            const maxW = Math.max(...labelled.map((x) => ctx.measureText(String(x.t.label)).width));
            const need = rot >= 45 ? font + 2 : maxW * Math.cos(rot * Math.PI / 180) - 6;   // Chart.js fits by its own measure: 6px of slack
            if (sp < need) why.push(k + ' labels overlap: ' + Math.round(sp) + 'px apart, ' + Math.round(need) + ' needed (rotation ' + Math.round(rot) + ')');
          }
          ctx.restore();
        }
      } else if (/^(linear|logarithmic)$/.test(s.type) && s.ticks.length < 3 && (s.max - s.min) >= 2 && (c.data.datasets || []).some((d) => (d.data || []).some((v) => v))) why.push(k + ': only ' + s.ticks.length + ' value ticks');
    });
    // stacked segments: distinct colours
    const stacked = c.options.scales && Object.values(c.options.scales).some((s) => s && s.stacked);
    if (stacked && c.data.datasets.length > 1) {
      // the colour as the first drawn element resolved it (a scriptable option is a function on the dataset)
      const resolved = (i) => { try { const m = c.getDatasetMeta(i); const e = m && m.data && m.data.find((d) => d && d.options); return e ? e.options.backgroundColor : null; } catch { return null; } };
      const cols = c.data.datasets.map((d, i) => col(resolved(i) || (typeof d.backgroundColor === 'string' ? d.backgroundColor : (Array.isArray(d.backgroundColor) ? d.backgroundColor[0] : ''))));
      for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) if ((c.data.datasets[i].data || []).some((v) => v) && (c.data.datasets[j].data || []).some((v) => v) && dist(cols[i], cols[j]) < 40) why.push('stacked datasets ' + i + ' and ' + j + ' nearly the same colour');
      cols.forEach((cc, i) => { if ((c.data.datasets[i].data || []).some((v) => v) && transparent(cc)) why.push('stacked dataset ' + i + ' transparent'); });
    }
    if (why.length) out.charts.push((canvas.id || 'canvas') + ': ' + why.join('; '));
  });
  // the chart grid: 90% of the content width when wide
  root.querySelectorAll('.ui-grid-charts').forEach((g) => {
    if (!vis(g)) return; n('grids');
    const parent = g.parentElement; const pw = parent.getBoundingClientRect().width - parseFloat(getComputedStyle(parent).paddingLeft) - parseFloat(getComputedStyle(parent).paddingRight);
    const gw = g.getBoundingClientRect().width;
    if (width >= 1360 && gw < 0.9 * pw) out.charts.push('the chart grid is ' + Math.round(gw) + 'px of ' + Math.round(pw));
    const cards = Array.from(g.children).filter((c) => vis(c) && !c.hasAttribute('data-wide'));   // a wide card spans the grid by design
    const cols = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left))).size;
    if (width >= 1360 && cards.length >= 3 && cols < 3) out.charts.push('the grid shows ' + cols + ' columns for ' + cards.length + ' cards at ' + width);
    if (width <= 720 && cols > 1) out.charts.push('the grid shows ' + cols + ' columns at ' + width);
    // equal heights per row (a card that wraps to the next row is its own row)
    const rowsOf = {}; cards.forEach((c) => { const t = Math.round(c.getBoundingClientRect().top); (rowsOf[t] = rowsOf[t] || []).push(Math.round(c.getBoundingClientRect().height)); });
    Object.values(rowsOf).forEach((hs) => { if (hs.length > 1 && Math.max(...hs) - Math.min(...hs) > 2) out.charts.push('the grid cards of one row differ in height: ' + hs.join('/')); });
  });

  // ---- tables ----
  root.querySelectorAll('table').forEach((t) => {
    if (!vis(t) || t.closest('.au-diff') || t.classList.contains('au-diff')) return; n('tables');
    const why = [];
    const wrap = t.parentElement;
    const wcs = getComputedStyle(wrap);
    if (!wrap.matches('.ui-table-wrap, .lc-table-wrap, .au-table-wrap, .kd-table-wrap, .bl-table-wrap')) why.push('not in a table box (' + name(wrap) + ')');
    else {
      if (wcs.borderTopWidth !== '1px') why.push('box border ' + wcs.borderTopWidth);
      if (wcs.borderTopLeftRadius !== radiusTable) why.push('box radius ' + wcs.borderTopLeftRadius + ' (token ' + radiusTable + ')');
      if (wcs.overflowX === 'visible' || wcs.overflowY === 'visible') why.push('box overflow visible (corners unclipped)');
    }
    const stacked = width <= 640 && getComputedStyle(t).display === 'block';
    if (!stacked) {
      const rows = Array.from(t.querySelectorAll('tbody > tr')).filter((r) => vis(r) && !r.classList.contains('ui-xrow-panel') && !r.querySelector('td[colspan]'));
      const single = rows.filter((r) => Array.from(r.children).every((td) => td.getBoundingClientRect().height < 44 && !td.querySelector('pre, table, ul')));
      const hs = single.map((r) => Math.round(r.getBoundingClientRect().height));
      if (hs.length > 1 && Math.max(...hs) - Math.min(...hs) > 1) why.push('row heights differ: ' + Math.min(...hs) + '..' + Math.max(...hs));
      // sortable headers: exactly one marker; non-sortable headers not clickable-looking
      const ths = Array.from(t.querySelectorAll('thead th')).filter(vis);
      const sortable = ths.filter((th) => th.hasAttribute('onclick') || th.querySelector('.lc-sort, button') || th.hasAttribute('data-key') || th.hasAttribute('data-sort'));
      if (sortable.length) {
        const marked = ths.filter((th) => th.hasAttribute('aria-sort'));
        if (marked.length !== 1) out.sorts.push(name(t) + ': ' + marked.length + ' sort markers on ' + sortable.length + ' sortable headers');
        else if (!['ascending', 'descending'].includes(marked[0].getAttribute('aria-sort'))) out.sorts.push(name(t) + ': aria-sort ' + marked[0].getAttribute('aria-sort'));
        ths.filter((th) => !sortable.includes(th) && !th.classList.contains('ui-xrow-th')).forEach((th) => { if (getComputedStyle(th).cursor === 'pointer') out.sorts.push(name(t) + ': non-sortable header "' + th.textContent.trim() + '" looks clickable'); });
      }
    }
    // expandable rows
    const xrows = t.querySelectorAll('tr.ui-xrow');
    if (xrows.length) {
      n('xrowTables');
      if (!t.querySelector('thead th.ui-xrow-th')) out.xrows.push(name(t) + ': no chevron header cell');
      xrows.forEach((r, i) => { if (i > 50) return; const b = r.querySelector('.ui-xrow-btn[aria-expanded]'); if (!b) out.xrows.push(name(t) + ': row ' + i + ' has no chevron button'); if (!r.hasAttribute('tabindex')) out.xrows.push(name(t) + ': row ' + i + ' not focusable'); const p = r.nextElementSibling; if (!p || !p.classList.contains('ui-xrow-panel')) out.xrows.push(name(t) + ': row ' + i + ' has no panel'); });
      if (!root.querySelector('[data-xrow-all="open"]') || !root.querySelector('[data-xrow-all="close"]')) out.xrows.push(name(t) + ': no Expand all / Collapse all');
      t.querySelectorAll('.ui-xrow-body h4, .ui-xrow-body .ui-kv-title').forEach((h) => { if (/^Details:?$/.test(h.textContent.trim())) out.xrows.push(name(t) + ': a raw "Details:" label'); });
    }
    // the legacy expandable pattern (a caret cell, a hidden details row) outside the component
    if (!xrows.length && t.querySelector('tbody tr[data-parent], tbody tr.hidden[data-parent]')) out.xrows.push(name(t) + ': expandable rows outside the shared component');
    if (why.length) out.tables.push(name(t) + ': ' + why.join('; '));
  });
  // the pagination outside the component
  root.querySelectorAll('[id*="agination"]').forEach((el) => { if (vis(el) && !el.classList.contains('ui-pager') && el.querySelector('button')) out.pagers.push(name(el) + ': pagination outside the shared pager'); });

  // ---- pagers ----
  root.querySelectorAll('.ui-pager').forEach((p) => {
    if (p.hidden) { if (p.querySelector('button')) { /* drawn but hidden: fine */ } return; }
    if (!vis(p)) return; n('pagers');
    const why = [];
    const btns = Array.from(p.querySelectorAll('button')).filter(vis);
    const hs = new Set(btns.map((b) => Math.round(b.getBoundingClientRect().height)));
    if (hs.size > 1) why.push('button heights ' + Array.from(hs).join('/'));
    else if (btns.length && !hs.has(30)) why.push('button height ' + Array.from(hs)[0]);
    btns.forEach((b) => { if (b.getBoundingClientRect().width < 28) why.push('"' + (b.textContent.trim() || b.title) + '" narrower than 28'); if (!/\bbtn\b/.test(b.className)) why.push('a bare button'); });
    const pages = btns.filter((b) => b.classList.contains('ui-pager-page'));
    const current = pages.filter((b) => b.getAttribute('aria-current') === 'page');
    if (width > 640) {
      if (pages.length < 2) why.push('shown with ' + pages.length + ' page button(s)');
      if (current.length !== 1) why.push(current.length + ' current pages');
      else if (!current[0].classList.contains('btn-selected')) why.push('the current page is not btn-selected');
      const cur = current[0] ? parseInt(current[0].textContent.replace(/[^\d]/g, ''), 10) : 0;
      const first = p.querySelector('.ui-pager-first'), prev = p.querySelector('.ui-pager-prev'), next = p.querySelector('.ui-pager-next'), last = p.querySelector('.ui-pager-last');
      if (cur === 1 && first && prev && !(first.disabled && prev.disabled)) why.push('First / Prev enabled on page 1');
      const lastNum = pages.length ? parseInt(pages[pages.length - 1].textContent.replace(/[^\d]/g, ''), 10) : 0;
      if (cur && cur === lastNum && next && last && !(next.disabled && last.disabled)) why.push('Next / Last enabled on the last page');
      p.querySelectorAll('.ui-pager-gap').forEach((g) => { if (g.tagName === 'BUTTON' || g.hasAttribute('tabindex')) why.push('an interactive ellipsis'); });
      if (!p.querySelector('.ui-pager-prev svg') || !p.querySelector('.ui-pager-next svg')) why.push('Prev / Next without chevron icons');
    } else {
      const compact = p.querySelector('.ui-pager-compact');
      if (!compact || !vis(compact)) why.push('no compact "Page N of M" under 640');
      if (pages.some(vis)) why.push('page numbers shown under 640');
    }
    const pr = p.getBoundingClientRect(); const host = (p.closest('.panel, .ui-card') || root).getBoundingClientRect();
    if (pr.right > host.right + 1) why.push('overflows its card');
    if (why.length) out.pagers.push(name(p) + ': ' + why.join('; '));
  });

  // ---- filter bars ----
  root.querySelectorAll('.ui-filterbar').forEach((bar) => {
    if (!vis(bar)) return; n('filterbars');
    const why = [];
    const kids = Array.from(bar.children).filter(vis);
    const controls = bar.querySelectorAll('input, select, button, .ui-chip');
    const br = bar.getBoundingClientRect();
    if (width >= 1920 && kids.length <= 6 && br.height > 30 + 16) why.push('taller than one row at ' + width + ': ' + Math.round(br.height) + 'px for ' + kids.length + ' items');
    if (width > 640) {   // under 640 the controls span the row by design
      bar.querySelectorAll('.ui-select-wrap').forEach((w) => { const ww = w.getBoundingClientRect().width; if (ww > 262) why.push('select ' + Math.round(ww) + 'px wide'); });
      bar.querySelectorAll('.ui-field').forEach((f) => { const fw = f.getBoundingClientRect().width; if (fw > 362) why.push('search ' + Math.round(fw) + 'px wide'); });
    }
    // uniform gaps on a row (the end block floats right: the gap before it is free)
    const gap = parseFloat(getComputedStyle(bar).columnGap) || 8;
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1].getBoundingClientRect(), b = kids[i].getBoundingClientRect();
      if (Math.abs(a.top - b.top) > 4 || kids[i].classList.contains('ui-end') || kids[i].classList.contains('ui-status')) continue;
      const g = b.left - a.right;
      if (Math.abs(g - gap) > 1.5) why.push('gap ' + Math.round(g) + 'px between ' + name(kids[i - 1]) + ' and ' + name(kids[i]) + ' (token ' + gap + ')');
    }
    bar.querySelectorAll('label').forEach((l) => { if (vis(l) && !l.querySelector('input, select, button, textarea') && !l.classList.contains('ui-rows')) why.push('a stacked label "' + l.textContent.trim().slice(0, 20) + '"'); });
    bar.querySelectorAll('input, select').forEach((c) => {
      if (!vis(c)) return;
      const named = c.getAttribute('aria-label') || c.getAttribute('aria-labelledby') || c.getAttribute('placeholder') || c.getAttribute('title') || (c.id && root.querySelector('label[for="' + c.id + '"]') && root.querySelector('label[for="' + c.id + '"]').textContent.trim()) || (c.closest('label') && c.closest('label').textContent.trim());
      if (!named) why.push(name(c) + ' has no accessible name');
    });
    if (br.right > root.getBoundingClientRect().right + 1 || bar.scrollWidth > bar.clientWidth + 1) why.push('overflows at ' + width);
    if (!controls.length) why.push('no control');
    if (why.length) out.filters.push(name(bar) + ': ' + why.join('; '));
  });
  // the older stacked-label pattern anywhere on the page
  root.querySelectorAll('label').forEach((l) => { if (vis(l) && getComputedStyle(l).display === 'block' && l.htmlFor && !l.querySelector('input, select')) { const c = document.getElementById(l.htmlFor); if (c && vis(c) && c.getBoundingClientRect().top >= l.getBoundingClientRect().bottom - 1 && c.matches('input, select')) out.filters.push('a label stacked above ' + name(c)); } });

  // ---- meters ----
  root.querySelectorAll('.ui-meter').forEach((m) => {
    if (!vis(m)) return; n('meters');
    const why = [];
    const track = m.querySelector('.ui-meter-track'), fill = m.querySelector('.ui-meter-fill');
    const value = parseFloat(m.getAttribute('aria-valuenow')) || 0, max = parseFloat(m.getAttribute('aria-valuemax')) || 100;
    if (!track || !fill) { out.meters.push(name(m) + ': no track / fill'); return; }
    const tcs = getComputedStyle(track), fcs = getComputedStyle(fill);
    if (value > 0) {
      if (transparent(fcs.backgroundColor)) why.push('transparent fill');
      if (dist(fcs.backgroundColor, tcs.backgroundColor) < 40) why.push('fill ' + fcs.backgroundColor + ' hardly differs from the track ' + tcs.backgroundColor);
      const want = Math.min(100, value / max * 100) / 100 * track.getBoundingClientRect().width;
      if (Math.abs(fill.getBoundingClientRect().width - want) > 2) why.push('fill ' + Math.round(fill.getBoundingClientRect().width) + 'px for ' + value + '% (want ' + Math.round(want) + ')');
      const role = m.getAttribute('data-role');
      if (role === 'warn' || role === 'bad') {
        const row = m.closest('tr');
        const keys = row ? Array.from(row.children).slice(0, 2).map((td) => td.textContent.replace(/\(pseudo\)/, '').trim().toLowerCase()).filter(Boolean) : [];
        if (keys.length && !findingsBy[role].some((t) => keys.some((k) => t.includes(k)))) why.push('role ' + role + ' with no ' + role + ' finding about ' + keys[0]);
      }
    }
    if (why.length) out.meters.push(name(m) + ': ' + why.join('; '));
  });

  // ---- chips ----
  const chips = Array.from(root.querySelectorAll('.ui-chip')).filter(vis);
  chips.forEach((c, i) => {
    n('chips');
    const why = [];
    const cs = getComputedStyle(c);
    if (cs.borderTopWidth !== '1px') why.push('border ' + cs.borderTopWidth);
    if (transparent(cs.backgroundColor)) why.push('transparent background');
    const active = /\b(ui-on|lc-on|au-on)\b/.test(c.className);
    if (active && dist(cs.backgroundColor, selectedBg) > 12) why.push('active chip background ' + cs.backgroundColor + ' is not the selected role ' + selectedBg);
    const cr = contrast(cs.color, cs.backgroundColor, cardBg);
    if (cr < 4.5) why.push('text contrast ' + cr.toFixed(2));
    // every part of the chip (a key such as "verb:", the value, the count, the ×) reads on the chip's background
    Array.from(c.children).filter((p) => p.textContent.trim() && vis(p)).forEach((p) => { const ps = getComputedStyle(p); const pc = contrast(ps.color, cs.backgroundColor, cardBg) ; const eff = pc * Math.max(0.5, Number(ps.opacity) || 1); if (eff < 4.5) why.push('"' + p.textContent.trim().slice(0, 12) + '" contrast ' + pc.toFixed(2) + (Number(ps.opacity) < 1 ? ' at opacity ' + ps.opacity : '')); });
    const dot = c.querySelector('.ui-dot, .lc-dot');
    if (dot && transparent(getComputedStyle(dot).backgroundColor)) why.push('an invisible dot');
    const prev = chips[i - 1];
    if (prev && prev.parentElement === c.parentElement && Math.abs(prev.getBoundingClientRect().top - c.getBoundingClientRect().top) < 4) { const g = c.getBoundingClientRect().left - prev.getBoundingClientRect().right; if (g < 5.5) why.push('gap ' + Math.round(g) + 'px to the previous chip'); }
    if (why.length) out.chips.push('"' + c.textContent.trim().slice(0, 24) + '": ' + why.join('; '));
  });

  // ---- the Log Collection band: distinct segments, legend swatch = segment, section dots = chip dots ----
  root.querySelectorAll('.lc-stack').forEach((band) => {
    if (!vis(band)) return; n('bands');
    const segs = Array.from(band.children).filter(vis).map((s) => ({ cls: Array.from(s.classList).find((k) => /^lc-c\d$/.test(k)), bg: getComputedStyle(s).backgroundColor }));
    segs.forEach((s, i) => { if (transparent(s.bg)) out.band.push('segment ' + i + ' transparent'); const nx = segs[i + 1]; if (nx && dist(s.bg, nx.bg) < 40) out.band.push('segments ' + i + ' and ' + (i + 1) + ' nearly the same colour'); });
    const legend = band.parentElement.querySelector('.lc-legend');
    if (legend) Array.from(legend.children).forEach((l) => { const cls = Array.from(l.classList).find((k) => /^lc-c\d$/.test(k)); const sw = getComputedStyle(l, '::before').backgroundColor; const seg = segs.find((s) => s.cls === cls); if (transparent(sw)) out.band.push('legend "' + l.textContent.trim().slice(0, 16) + '" swatch transparent'); else if (seg && dist(sw, seg.bg) > 12) out.band.push('legend "' + l.textContent.trim().slice(0, 16) + '" swatch != segment'); });
    else out.band.push('no legend under the band');
  });
  root.querySelectorAll('.lc-td-sec .lc-dot').forEach((d, i) => { if (i > 30 || !vis(d)) return; const cls = Array.from(d.classList).find((k) => /^lc-c\d$/.test(k)); const chip = root.querySelector('.lc-chip .lc-dot.' + cls); if (transparent(getComputedStyle(d).backgroundColor)) out.band.push('a section dot is invisible'); else if (chip && dist(getComputedStyle(d).backgroundColor, getComputedStyle(chip).backgroundColor) > 12) out.band.push('a section dot differs from its chip'); });

  probe.remove();
  return out;
}, opts || {});

export const stability = (frame) => frame.evaluate(() => ({
  frame: document.body.scrollHeight,
  charts: Array.from(document.querySelectorAll('canvas')).filter((c) => c.getBoundingClientRect().height > 0).map((c) => [c.id || '?', Math.round(c.getBoundingClientRect().height)]),
}));

export const toggleDetails = (frame) => frame.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const docH = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, Math.round(document.documentElement.getBoundingClientRect().height));
  const all = Array.from(document.querySelectorAll('#diagnostics-content details')).filter((d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).slice(0, 6);
  for (const [i, d] of all.entries()) {
    const summary = d.querySelector(':scope > summary'); if (!summary) { out.push('details ' + i + ' has no summary'); continue; }
    const was = d.open; const h0 = docH(); const own0 = d.getBoundingClientRect().height;
    summary.click(); await sleep(120);
    if (d.open === was) { out.push('details ' + i + ' ("' + summary.textContent.trim().slice(0, 24) + '") did not toggle on click'); continue; }
    const h1 = docH(); const own1 = d.getBoundingClientRect().height;
    const body = Array.from(d.children).find((c) => c !== summary);
    const bodyVisible = !!body && body.getBoundingClientRect().height > 0;
    if (d.open && !bodyVisible) out.push('details ' + i + ' opened but its content has no height');
    if (d.open && h1 <= h0 && own1 <= own0 && bodyVisible && body.getBoundingClientRect().height > 4 && !d.closest('.ui-menu')) out.push('details ' + i + ' opened but neither the document nor the element grew (' + h0 + ' -> ' + h1 + ')');
    if (!d.open && h1 >= h0 && own1 >= own0 && was && !d.closest('.ui-menu')) out.push('details ' + i + ' closed but nothing shrank (' + h0 + ' -> ' + h1 + ')');
    // keyboard: Enter on the summary toggles back
    summary.focus();
    summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    if (d.open !== was) { summary.click(); await sleep(60); }   // a browser toggles details on Enter natively only through a real key press: click back
    if (d.open !== was) out.push('details ' + i + ' did not return to its state');
  }
  return { count: all.length, problems: out };
});

export const exerciseXrows = (frame) => frame.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const tables = Array.from(document.querySelectorAll('#diagnostics-content table')).filter((t) => t.querySelector('tr.ui-xrow') && t.getBoundingClientRect().height > 0);
  for (const t of tables) {
    const rows = Array.from(t.querySelectorAll('tr.ui-xrow')).filter((r) => !r.hidden && r.getBoundingClientRect().height > 0);
    if (!rows.length) continue;
    const row = rows[0], panel = row.nextElementSibling;
    const h0 = document.body.scrollHeight;
    row.querySelector('td:nth-child(2)').click(); await sleep(120);
    if (panel.hidden || row.getAttribute('aria-expanded') !== 'true' || row.querySelector('.ui-xrow-btn').getAttribute('aria-expanded') !== 'true') out.push(t.id + ': a click on the row did not open it');
    const body = panel.querySelector('.ui-xrow-body');
    const left = body ? body.getBoundingClientRect().left : 0, want = row.children[1].getBoundingClientRect().left;
    if (body && Math.abs(left - want) > 2 && document.documentElement.clientWidth > 640) out.push(t.id + ': the panel starts at ' + Math.round(left) + ', the first content column at ' + Math.round(want));
    if (body && !body.querySelector('.ui-kv, pre, ul, table, .ui-xrow-actions')) out.push(t.id + ': the panel has no key/value grid or section');
    if (document.body.scrollHeight <= h0) out.push(t.id + ': the document did not grow when a row opened');
    if (!row.classList.contains('ui-open') || getComputedStyle(row.children[0]).boxShadow === 'none') out.push(t.id + ': the open row has no accent');
    row.querySelector('td:nth-child(2)').click(); await sleep(60);
    if (!panel.hidden) out.push(t.id + ': a second click did not close it');
    // the keyboard on the second row
    const r2 = rows[1] || rows[0];
    r2.focus(); r2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(60);
    if (r2.nextElementSibling.hidden) out.push(t.id + ': Enter on a focused row did not open it');
    r2.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); await sleep(60);
    if (!r2.nextElementSibling.hidden) out.push(t.id + ': Space did not close it');
    // expand all / collapse all
    const open = document.querySelector('[data-xrow-all="open"]'), close = document.querySelector('[data-xrow-all="close"]');
    if (open && close) {
      open.click(); await sleep(150);
      const openCount = rows.filter((r) => !r.nextElementSibling.hidden).length;
      if (openCount !== rows.length) out.push(t.id + ': Expand all opened ' + openCount + ' of ' + rows.length);
      close.click(); await sleep(100);
      if (rows.some((r) => !r.nextElementSibling.hidden)) out.push(t.id + ': Collapse all left rows open');
    }
  }
  return { tables: tables.length, problems: out };
});

export const exerciseSort = (frame) => frame.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = []; let tried = 0;
  const tables = Array.from(document.querySelectorAll('#diagnostics-content table')).filter((t) => t.getBoundingClientRect().height > 0 && !t.closest('.ui-xrow-body'));
  for (const t of tables) {
    const ths = Array.from(t.querySelectorAll('thead th')).filter((th) => th.getBoundingClientRect().width > 0);
    const sortable = ths.filter((th) => th.hasAttribute('onclick') || th.querySelector('.lc-sort, button') || th.hasAttribute('data-key') || th.hasAttribute('data-sort'));
    const marked = ths.find((th) => th.hasAttribute('aria-sort'));
    const other = sortable.find((th) => th !== marked && !th.classList.contains('ui-xrow-th'));
    if (!marked || !other) continue;
    tried++;
    const col = Array.from(t.querySelectorAll('thead th')).indexOf(other);
    const before = Array.from(t.querySelectorAll('tbody > tr')).filter((r) => !r.classList.contains('ui-xrow-panel') && !r.hidden && r.style.display !== 'none').slice(0, 20).map((r) => (r.children[col] || r).textContent.trim());
    (other.querySelector('.lc-sort, button') || other).click(); await sleep(250);
    if (other.getAttribute('aria-sort') === null) { out.push(t.id + ': clicking "' + other.textContent.trim() + '" did not move the marker'); continue; }
    if (marked.hasAttribute('aria-sort')) out.push(t.id + ': the old marker stayed on "' + marked.textContent.trim() + '"');
    const after = Array.from(t.querySelectorAll('tbody > tr')).filter((r) => !r.classList.contains('ui-xrow-panel') && !r.hidden && r.style.display !== 'none').slice(0, 20).map((r) => (r.children[col] || r).textContent.trim());
    const distinct = new Set(before).size > 1;
    const sortedAsc = after.every((v, i) => i === 0 || String(after[i - 1]).localeCompare(String(v), undefined, { numeric: true }) <= 0);
    const sortedDesc = after.every((v, i) => i === 0 || String(after[i - 1]).localeCompare(String(v), undefined, { numeric: true }) >= 0);
    if (distinct && before.join('|') === after.join('|') && !(sortedAsc || sortedDesc)) out.push(t.id + ': the rows did not reorder on "' + other.textContent.trim() + '"');
    // back to the first column's order
    (marked.querySelector('.lc-sort, button') || marked).click(); await sleep(150);
  }
  return { tried, problems: out };
});

export const exercisePager = (frame) => frame.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = []; let tried = 0;
  for (const p of Array.from(document.querySelectorAll('#diagnostics-content .ui-pager')).filter((p) => !p.hidden && p.getBoundingClientRect().height > 0)) {
    const two = Array.from(p.querySelectorAll('.ui-pager-page')).find((b) => b.textContent.trim() === '2');
    if (!two) continue;
    tried++;
    two.click(); await sleep(250);
    const cur = p.querySelector('[aria-current="page"]');
    if (!cur || cur.textContent.trim() !== '2') { out.push((p.id || 'pager') + ': page 2 did not become current'); continue; }
    if (!cur.classList.contains('btn-selected')) out.push((p.id || 'pager') + ': page 2 is not btn-selected');
    if (p.querySelector('.ui-pager-first').disabled || p.querySelector('.ui-pager-prev').disabled) out.push((p.id || 'pager') + ': First / Prev still disabled on page 2');
    p.querySelector('.ui-pager-prev').click(); await sleep(200);
    const back = p.querySelector('[aria-current="page"]');
    if (!back || back.textContent.trim() !== '1') out.push((p.id || 'pager') + ': Prev did not return to page 1');
  }
  return { tried, problems: out };
});

export const pagerShapes = (frame) => frame.evaluate(() => {
  const out = [];
  const nav = document.createElement('nav'); document.body.appendChild(nav);
  const shape = (page) => { window.diagPager.render(nav, { total: 27527, pageSize: 100, page, go: () => {} }); return Array.from(nav.querySelector('.ui-pager-numbers').children).map((c) => c.classList.contains('ui-pager-gap') ? '…' : (c.getAttribute('aria-current') ? '[' + c.textContent + ']' : c.textContent)).join(' '); };
  const s1 = shape(1), s2 = shape(138), s3 = shape(276);
  if (!/^\[1\] 2 3 … 276$/.test(s1)) out.push('page 1 window: ' + s1);
  if (!/^1 … 136 137 \[138\] 139 140 … 276$/.test(s2)) out.push('middle window: ' + s2);
  if (!/^1 … 274 275 \[276\]$/.test(s3)) out.push('last window: ' + s3);
  if (!nav.querySelector('.ui-pager-last').disabled || !nav.querySelector('.ui-pager-next').disabled) out.push('Next / Last enabled on the last page');
  const input = nav.querySelector('.ui-pager-goto input');
  if (!input) out.push('no go-to-page box for 276 pages');
  else {
    let went = null;
    window.diagPager.render(nav, { total: 27527, pageSize: 100, page: 1, go: (p) => { went = p; } });
    const box = nav.querySelector('.ui-pager-goto input'); box.value = '42'; box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    if (went !== 42) out.push('Enter in the go-to box went to ' + went);
  }
  window.diagPager.render(nav, { total: 50, pageSize: 100, page: 1, go: () => {} });
  if (!nav.hidden) out.push('a one-page pager is not hidden');
  nav.remove();
  return out;
});

/**
 * Containment: every chart canvas inside its card (±1 px), no two cards overlapping, no canvas over anything
 * outside its own card. Returns { problems, cards: [{ left, top, right, bottom, name }], n }.
 */
export const containment = (frame) => frame.evaluate(() => {
  const root = document.querySelector('#diagnostics-content') || document.body;
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left + scrollX, top: r.top + scrollY, right: r.right + scrollX, bottom: r.bottom + scrollY }; };
  const inside = (a, b, tol) => a.left >= b.left - tol && a.right <= b.right + tol && a.top >= b.top - tol && a.bottom <= b.bottom + tol;
  const overlaps = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  const problems = [];
  const CARD = '[data-chart-card], .au-visual, .ui-card, .panel';
  const canvases = Array.from(root.querySelectorAll('canvas')).filter(vis);
  const cards = Array.from(root.querySelectorAll(CARD)).filter(vis);
  const cardRects = cards.map((c) => ({ el: c, r: rect(c), name: name(c) }));
  canvases.forEach((cv) => {
    const card = cv.closest(CARD);
    const r = rect(cv);
    if (!card) { problems.push(name(cv) + ' is in no card'); return; }
    if (!inside(r, rect(card), 1)) problems.push(name(cv) + ' (' + Math.round(r.top) + '-' + Math.round(r.bottom) + ') runs past its card ' + name(card) + ' (' + Math.round(rect(card).top) + '-' + Math.round(rect(card).bottom) + ')');
    const box = cv.closest('.ui-chart');
    if (box && !inside(r, rect(box), 1)) problems.push(name(cv) + ' runs past its .ui-chart box');
    // nothing outside the card under the canvas: the other cards, the strip, the tables, the notes
    cardRects.forEach((o) => { if (o.el !== card && !o.el.contains(card) && !card.contains(o.el) && overlaps(r, o.r)) problems.push(name(cv) + ' overlaps ' + o.name); });
    Array.from(root.querySelectorAll('.ui-findings, table, .au-hist-note, .au-legend, .au-visual-title, .ui-card-title, h3')).filter(vis).forEach((o) => { if (!card.contains(o) && overlaps(r, rect(o))) problems.push(name(cv) + ' overlaps ' + name(o)); });
    // the card's own text (title, legend, the gap note) sits beside the chart, never under it (the 'log scale'
    // corner badge is the box's own annotation and may sit on the chart)
    Array.from(card.querySelectorAll('.au-hist-note, .au-legend, .au-visual-title, .ui-card-title, h3, h4')).filter((o) => vis(o) && o.textContent.trim()).forEach((o) => { if (!o.contains(cv) && overlaps(r, rect(o))) problems.push(name(cv) + ' is drawn under its card\'s ' + name(o)); });
  });
  // the cards themselves never overlap (a nested card is inside its parent, which is fine)
  for (let i = 0; i < cardRects.length; i++) for (let j = i + 1; j < cardRects.length; j++) {
    const a = cardRects[i], b = cardRects[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    if (overlaps(a.r, b.r)) problems.push('cards overlap: ' + a.name + ' and ' + b.name);
  }
  return { problems, n: { canvases: canvases.length, cards: cardRects.length }, cards: cardRects.filter((c) => c.el.querySelector('canvas')).map((c) => ({ ...c.r, name: c.name })) };
});

/**
 * The bar sizing of the shared helper on a scratch canvas: for 1 / 2 / 3 / 5 / 16 / 64 / 256 categories the bars
 * are at least 2 px wide, never touch, grow no wider as the count grows, and a 1 next to 100,000 still shows.
 */
export const barSizingCheck = (frame) => frame.evaluate(() => {
  const out = [];
  const host = document.createElement('div'); host.style.cssText = 'width: 900px; height: 240px; position: absolute; left: -2000px; top: 0';
  document.body.appendChild(host);
  let lastMax = Infinity;
  for (const n of [1, 2, 3, 5, 16, 64, 256]) {
    const canvas = document.createElement('canvas'); host.appendChild(canvas);
    const labels = Array.from({ length: n }, (_, i) => 'c' + i);
    const data = labels.map((_, i) => (i === 0 ? 1 : 100000));
    const c = window.diagChart.make(canvas, { type: 'bar', data: { labels, datasets: [{ label: 'v', data, role: 'ok' }] }, options: { animation: false, plugins: { legend: { display: false } } } });
    if (!c) { out.push(n + ': no chart'); continue; }
    const bars = c.getDatasetMeta(0).data.map((b) => ({ x: b.x, w: b.width, h: Math.abs(b.base - b.y) }));
    const widths = bars.map((b) => b.w);
    const maxW = Math.max(...widths), minW = Math.min(...widths);
    if (minW < 2) out.push(n + ' categories: a bar is ' + minW.toFixed(1) + 'px wide');
    if (maxW > lastMax + 0.5) out.push(n + ' categories: bars wider (' + maxW.toFixed(1) + ') than with fewer categories (' + lastMax.toFixed(1) + ')');
    lastMax = maxW;
    const xs = bars.map((b) => b.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) { if (xs[i] - xs[i - 1] < maxW + 0.5) { out.push(n + ' categories: bars touch (' + (xs[i] - xs[i - 1]).toFixed(1) + 'px apart, ' + maxW.toFixed(1) + ' wide)'); break; } }
    if (bars[0].h < 2) out.push(n + ' categories: the value 1 draws ' + bars[0].h.toFixed(1) + 'px (minBarLength)');
    const sizing = c.data.datasets[0];
    if (!sizing.maxBarThickness || !(sizing.minBarLength >= 2)) out.push(n + ' categories: the dataset did not get the shared sizing');
    c.destroy();
  }
  host.remove();
  return out;
});

/**
 * The chart role colours: every bar / point / segment with a role is the theme's --chart-<role> token, the WARN
 * badge's border and the warn finding accent are that same amber, the meters' fills are the role tokens.
 */
export const roleColours = (frame) => frame.evaluate(() => {
  const problems = [];
  // a colour as 0-255 channels: rgb()/rgba() as is, a color-mix() result (color(srgb r g b / a)) scaled from 0-1
  const rgb = (v) => { const t = document.createElement('span'); t.style.color = 'rgb(1, 2, 3)'; t.style.color = v; document.body.appendChild(t); const cs = getComputedStyle(t).color; t.remove(); const m = cs.match(/[\d.]+/g); if (!m) return null; const ch = m.slice(0, 3).map(Number); return /^color\(srgb/.test(cs) ? ch.map((x) => Math.round(x * 255)) : ch; };
  const near = (a, b) => !!a && !!b && a.every((v, k) => Math.abs(v - b[k]) <= 6);
  const tokenOf = (role) => ({ ok: 'ok', good: 'good', error: 'bad', bad: 'bad', warn: 'warn', info: 'info', other: 'muted', neutral: 'muted', muted: 'muted' })[role];
  const token = (name) => rgb(getComputedStyle(document.documentElement).getPropertyValue('--chart-' + name).trim() || 'transparent');
  let charts = 0;
  (window.Chart && Chart.instances ? Object.values(Chart.instances) : []).forEach((c) => {
    if (!c.canvas || !c.canvas.isConnected) return;
    charts += 1;
    c.data.datasets.forEach((ds, di) => {
      const meta = c.getDatasetMeta(di); if (meta.hidden || !meta.data.length) return;
      meta.data.forEach((el, i) => {
        const role = (ds.roles && ds.roles[i]) || ds.role; const t = role && tokenOf(role); if (!t) return;
        const got = rgb(el.options.backgroundColor); const want = token(t);
        if (!near(got, want)) problems.push(`${c.canvas.id || 'canvas'} dataset ${di} "${ds.label}" bar ${i} role ${role}: rgb(${got}) is not --chart-${t} rgb(${want})`);
      });
    });
  });
  const warn = token('warn');
  const badge = document.querySelector('.ui-badge-warn');
  if (badge && !near(rgb(getComputedStyle(badge).borderTopColor), warn)) problems.push(`the WARN badge's border rgb(${rgb(getComputedStyle(badge).borderTopColor)}) is not --chart-warn rgb(${warn})`);
  const finding = document.querySelector('.ui-finding-warn');
  if (finding && !near(rgb(getComputedStyle(finding).borderLeftColor), warn)) problems.push('the warn finding accent is not --chart-warn');
  document.querySelectorAll('.ui-meter[data-role]').forEach((m) => { const fill = m.querySelector('.ui-meter-fill'); const t = tokenOf(m.dataset.role); if (!fill || !t) return; if (!near(rgb(getComputedStyle(fill).backgroundColor), token(t))) problems.push(`a ${m.dataset.role} meter's fill is not --chart-${t}`); });
  return { problems: problems.slice(0, 8), charts, warn };
});

/**
 * The frame's fonts: the theme's families are loaded in the frame (Sora, Red Hat Text, Red Hat Mono as real
 * FontFace entries, not only "no face matches"), --font-sans resolves, and a sample of the page's text (the
 * strip, a cell, a title, a chip, body) is set in one of those families - never a serif fallback.
 */
export const fontCheck = (frame) => frame.evaluate(async () => {
  const problems = [];
  // the faces are in the frame (a face nobody uses stays "unloaded" until asked, so ask)
  const faces = (fam) => Array.from(document.fonts).filter((f) => f.family.replace(/["']/g, '') === fam);
  for (const fam of ['Sora', 'Red Hat Text', 'Red Hat Mono']) {
    if (!faces(fam).length) { problems.push(fam + ' has no FontFace in the frame'); continue; }
    try { await document.fonts.load('12px "' + fam + '"'); } catch { /* reported below */ }
    if (!faces(fam).some((f) => f.status === 'loaded')) problems.push(fam + ' does not load in the frame (' + faces(fam).map((f) => f.status).join(',') + ')');
  }
  const sans = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim();
  if (!sans) problems.push('--font-sans does not resolve in the frame');
  const SANS = /^(["']?)(Sora|Red Hat Text)\1/;
  const MONO = /^(["']?)Red Hat Mono\1/;
  const sample = [document.body, document.querySelector('.ui-findings'), document.querySelector('.ui-finding'), document.querySelector('table td'), document.querySelector('th'), document.querySelector('h3, .ui-card-title, .au-visual-title'), document.querySelector('.ui-chip'), document.querySelector('.ui-input, .ui-select'), document.querySelector('button')].filter(Boolean);
  sample.forEach((el) => { const ff = getComputedStyle(el).fontFamily; if (!SANS.test(ff) && !MONO.test(ff)) problems.push((el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/)[0] : '')) + ' is set in ' + ff.slice(0, 40)); });
  const mono = document.querySelector('.ui-mono, code, pre');
  if (mono && !MONO.test(getComputedStyle(mono).fontFamily)) problems.push('a mono element is set in ' + getComputedStyle(mono).fontFamily.slice(0, 40));
  return { problems: problems.slice(0, 8), sampled: sample.length };
});
