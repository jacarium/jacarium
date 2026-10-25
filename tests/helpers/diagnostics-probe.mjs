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
    if (t.hasAttribute('data-auto-xrows')) return;   // the fit's own chevrons for hidden columns: the hiddenColumns probe covers them
    const xrows = t.querySelectorAll('tr.ui-xrow');
    if (xrows.length) {
      n('xrowTables');
      if (!t.querySelector('thead th.ui-xrow-th')) out.xrows.push(name(t) + ': no chevron header cell');
      xrows.forEach((r, i) => { if (i > 50) return; const b = r.querySelector('.ui-xrow-btn[aria-expanded]'); if (!b) out.xrows.push(name(t) + ': row ' + i + ' has no chevron button'); if (!r.hasAttribute('tabindex')) out.xrows.push(name(t) + ': row ' + i + ' not focusable'); const p = r.nextElementSibling; if (!p || !p.classList.contains('ui-xrow-panel')) out.xrows.push(name(t) + ': row ' + i + ' has no panel'); });
      if (!t.hasAttribute('data-auto-xrows') && (!root.querySelector('[data-xrow-all="open"]') || !root.querySelector('[data-xrow-all="close"]'))) out.xrows.push(name(t) + ': no Expand all / Collapse all');
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
  const tables = Array.from(document.querySelectorAll('#diagnostics-content table')).filter((t) => t.querySelector('tr.ui-xrow') && !t.hasAttribute('data-auto-xrows') && t.getBoundingClientRect().height > 0);
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

/**
 * The tables fit their box: no .ui-table-wrap scrolls sideways (scrollWidth <= clientWidth + 1) unless the table is
 * a marked wide one (table.ui-wide: the first column sticky, the scroll hint in the box; allowed by the test's list
 * with a reason); a cell cut by the ellipsis carries its whole value in its title; no header is clipped sideways.
 * Returns { problems, wide: [ids of the wide tables], tables }.
 */
export const tablesFit = (frame) => frame.evaluate(() => {
  const root = document.querySelector('#diagnostics-content') || document.body;
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const problems = [], wide = [];
  let tables = 0;
  Array.from(root.querySelectorAll('.ui-table-wrap')).filter(vis).forEach((wrap) => {
    const table = wrap.querySelector(':scope > table'); if (!table || !vis(table)) return;
    tables += 1;
    const id = table.id || name(table);
    const over = wrap.scrollWidth > wrap.clientWidth + 1;
    if (table.classList.contains('ui-wide')) {
      wide.push(id);
      const th = table.querySelector('thead th'); const cs = th ? getComputedStyle(th) : null;
      if (!cs || cs.position !== 'sticky') problems.push(id + ': a wide table without a sticky first column');
      if (!wrap.querySelector('.ui-scroll-hint')) problems.push(id + ': a wide table without the scroll hint');
    } else if (over) problems.push(id + ' scrolls sideways: ' + wrap.scrollWidth + ' > ' + wrap.clientWidth);
    if (document.documentElement.clientWidth > 640) {
      let wrapped = 0;
      Array.from(table.querySelectorAll('tbody td')).filter(vis).slice(0, 400).forEach((td) => {
        const cs = getComputedStyle(td);
        const compact = /\bui-col-(num|status|icon)\b/.test(td.className);
        // a text cell never cuts with an ellipsis (only a clamped long-content cell hides lines)
        if (!compact && cs.textOverflow === 'ellipsis' && !td.querySelector('.ui-clamp')) problems.push(id + ': a text cell with an ellipsis ("' + td.textContent.trim().slice(0, 24) + '")');
        if (!compact && td.scrollWidth > td.clientWidth + 1 && !td.querySelector('.ui-clamp, .ui-chips, .ui-meter')) problems.push(id + ': a text cell cut sideways ("' + td.textContent.trim().slice(0, 24) + '")');
        // a number stays on one line
        if (/\bui-col-num\b/.test(td.className) && td.textContent.trim()) { const rg = document.createRange(); rg.selectNodeContents(td); const h = rg.getBoundingClientRect().height; if (h > parseFloat(cs.lineHeight || '18') * 1.6) problems.push(id + ': a number cell on two lines ("' + td.textContent.trim().slice(0, 24) + '")'); }
        // a wrapped identifier breaks at a natural place (a space, - / . _ : =), never mid-word while a break exists
        if (!compact && wrapped < 12 && td.textContent.trim().length > 16 && !td.children.length) {
          const h = td.getBoundingClientRect().height; if (h < parseFloat(cs.lineHeight || '18') * 1.8) return;
          wrapped += 1;
          const range = document.createRange(); const node = td.firstChild; const text = node.nodeValue || '';
          let lastTop = null;
          for (let i = 0; i < text.length; i++) {
            range.setStart(node, i); range.setEnd(node, i + 1);
            const rect = range.getBoundingClientRect(); if (!rect.width && !rect.height) continue;
            if (lastTop !== null && rect.top > lastTop + 2 && i > 0) {
              const before = text[i - 1], at = text[i];
              const natural = /[\s\-\/._:=]/.test(before) || /[\s\-\/._:=]/.test(at) || !/[\s\-\/._:=]/.test(text);
              if (!natural) { problems.push(id + ': "' + text.slice(Math.max(0, i - 12), i) + '|' + text.slice(i, i + 12) + '" breaks mid-word with a natural break available'); break; }
            }
            lastTop = rect.top;
          }
        }
      });
      Array.from(table.querySelectorAll('thead th')).forEach((th) => { if (th.scrollWidth > th.clientWidth + 2) problems.push(id + ': header "' + th.textContent.trim().slice(0, 24) + '" is clipped (' + th.scrollWidth + ' > ' + th.clientWidth + ')'); });
    }
  });
  return { problems: problems.slice(0, 8), wide, tables, fit: Object.fromEntries(Array.from(root.querySelectorAll('table.ui-wide')).map((t) => [t.id || name(t), t.$fitDebug ? JSON.stringify(t.$fitDebug).slice(0, 400) : ''])) };
});

/**
 * The page stack: in every .ui-stack (the content root and the wrapper divs the helper marks) each pair of vertically
 * adjacent visible blocks sits --ui-stack-gap apart (±1 px) and nothing touches or overlaps.
 */
export const stackGaps = (frame) => frame.evaluate(() => {
  const root = document.querySelector('#diagnostics-content') || document.body;
  const gap = parseFloat(getComputedStyle(root).getPropertyValue('--ui-stack-gap')) || 16;
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const problems = []; let pairs = 0;
  Array.from(root.querySelectorAll('.ui-stack')).concat(root.classList.contains('ui-stack') ? [root] : []).forEach((stack) => {
    const kids = Array.from(stack.children).filter(vis);
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1].getBoundingClientRect(), b = kids[i].getBoundingClientRect();
      if (b.top < a.bottom - 1 && b.left < a.right && a.left < b.right) { if (b.top >= a.top) problems.push(name(kids[i - 1]) + ' and ' + name(kids[i]) + ' overlap'); continue; }   // side by side in a grid row: no vertical pair
      if (b.left >= a.right - 1 || a.left >= b.right - 1) continue;   // not stacked vertically
      pairs += 1;
      const g = b.top - a.bottom;
      if (Math.abs(g - gap) > 1) problems.push(name(kids[i - 1]) + ' -> ' + name(kids[i]) + ': ' + Math.round(g) + 'px gap, not ' + gap);
    }
  });
  return { problems: problems.slice(0, 8), pairs, gap };
});

/**
 * A table with hidden columns: every visible row carries the shared chevron, and opening the first row shows the
 * hidden columns' values (dt = the hidden headers) in its details.
 */
export const hiddenColumns = (frame) => frame.evaluate(async () => {
  const problems = []; let tables = 0;
  for (const table of Array.from(document.querySelectorAll('table.ui-fit'))) {
    const hiddenHeads = Array.from(table.querySelectorAll('thead th.ui-col-hidden')).map((h) => h.textContent.replace(/\s+/g, ' ').trim());
    if (!hiddenHeads.length) continue;
    tables += 1;
    const id = table.id || 'table.' + table.className.split(/\s+/).slice(0, 2).join('.');
    const rows = Array.from(table.tBodies[0] ? table.tBodies[0].rows : []).filter((r) => !r.classList.contains('ui-xrow-panel') && r.offsetParent !== null && !(r.cells[0] && r.cells[0].colSpan > 1));
    const without = rows.filter((r) => !r.querySelector('.ui-xrow-btn'));
    if (without.length) { problems.push(id + ': ' + without.length + ' of ' + rows.length + ' rows without a chevron while ' + hiddenHeads.join(', ') + ' hide'); continue; }
    if (!rows.length) continue;
    const row = rows[0]; window.diagTables.open(row, true); await new Promise((r) => setTimeout(r, 120));
    const panel = row.nextElementSibling;
    const dts = panel && !panel.hidden ? Array.from(panel.querySelectorAll('.ui-kv-hidden dt')).map((d) => d.textContent.trim()) : [];
    const missing = hiddenHeads.filter((h) => !dts.includes(h));
    if (missing.length) problems.push(id + ': the opened row does not show the hidden ' + missing.join(', ') + ' (shows ' + dts.join(', ') + ')');
    window.diagTables.open(row, false);
    const note = table.parentElement.nextElementSibling;
    if (!note || !note.classList.contains('ui-table-note') || !/chevron/.test(note.textContent)) problems.push(id + ': no note under the table saying the hidden values open from a row');
  }
  return { problems: problems.slice(0, 8), tables };
});

/**
 * Sortable headers: every button inside a <th> looks like the shared header (no border, no background, the header's
 * font), and a sortable table shows exactly one active marker whose column agrees with the row order.
 */
export const headerButtons = (frame) => frame.evaluate(() => {
  const problems = []; let buttons = 0, tables = 0;
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  document.querySelectorAll('#diagnostics-content table').forEach((t) => {
    const ths = Array.from(t.querySelectorAll('thead th')).filter(vis); if (!ths.length) return;
    const id = t.id || 'table.' + (t.className || '').split(/\s+/).slice(0, 2).join('.');
    ths.forEach((th) => {
      const b = th.querySelector('button'); if (!b || !vis(b)) return;
      buttons += 1;
      const cs = getComputedStyle(b), hs = getComputedStyle(th);
      if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') problems.push(id + ': the header button "' + b.textContent.trim().slice(0, 16) + '" has a border');
      if (!/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) problems.push(id + ': the header button "' + b.textContent.trim().slice(0, 16) + '" has a background');
      if (cs.fontSize !== hs.fontSize || cs.textTransform !== hs.textTransform) problems.push(id + ': the header button "' + b.textContent.trim().slice(0, 16) + '" is not in the header\'s type (' + cs.fontSize + ' ' + cs.textTransform + ')');
    });
    const sortable = ths.filter((th) => th.hasAttribute('onclick') || th.classList.contains('cursor-pointer') || th.querySelector('button') || th.hasAttribute('data-key'));
    if (sortable.length < 2) return;
    tables += 1;
    const active = ths.filter((th) => th.hasAttribute('aria-sort'));
    if (active.length !== 1) { problems.push(id + ': ' + active.length + ' active sort markers on ' + sortable.length + ' sortable headers'); return; }
    const th = active[0], dir = th.getAttribute('aria-sort'), i = ths.indexOf(th);
    const rows = Array.from(t.tBodies[0] ? t.tBodies[0].rows : []).filter((r) => !r.classList.contains('ui-xrow-panel') && r.offsetParent !== null && !(r.cells[0] && r.cells[0].colSpan > 1)).slice(0, 60);
    const vals = rows.map((r) => { const c = r.cells[i]; if (!c) return null; const raw = c.getAttribute('data-raw'); const txt = (raw !== null ? raw : c.textContent).trim().replace(/[,\s]/g, ''); return /^[-+]?\d+(\.\d+)?%?$/.test(txt) ? parseFloat(txt) : txt.toLowerCase(); }).filter((v) => v !== null && v !== '' && v !== '-');   // a figure only when the whole cell is one (a '1 min 0.0 s' is text)
    if (vals.some((v) => typeof v !== 'number')) return;   // a text column's order (a state's rank, a size's unit) is the page's own; only figures are checked
    let ordered = true;
    for (let k = 1; k < vals.length; k++) { const a = vals[k - 1], b = vals[k]; if (typeof a !== typeof b) continue; const cmp = typeof a === 'number' ? a - b : a.localeCompare(b); if (dir === 'ascending' ? cmp > 0 : cmp < 0) { ordered = false; break; } }
    if (!ordered) problems.push(id + ': the rows do not follow the marked column "' + th.textContent.trim().slice(0, 16) + '" ' + dir + ' (' + vals.slice(0, 6).join(', ') + ')');
  });
  return { problems: problems.slice(0, 8), buttons, tables };
});

/** The chart grid: no row with an empty slot while the cards could fill it (an odd last card spans the row). */
export const chartGrid = (frame) => frame.evaluate(() => {
  const problems = []; let grids = 0;
  document.querySelectorAll('#diagnostics-content .ui-grid-charts').forEach((g) => {
    const cards = Array.from(g.children).filter((c) => c.getBoundingClientRect().height > 0); if (cards.length < 2) return;
    grids += 1;
    const W = g.getBoundingClientRect().width;
    const rows = new Map(); cards.forEach((c) => { const top = Math.round(c.getBoundingClientRect().top); const r = rows.get(top) || []; r.push(c); rows.set(top, r); });
    rows.forEach((cs) => { const right = Math.max(...cs.map((c) => c.getBoundingClientRect().right)); const left = Math.min(...cs.map((c) => c.getBoundingClientRect().left)); const used = right - left; if (W - used > 40) problems.push((cards.indexOf(cs[0]) + 1) + 'th card row uses ' + Math.round(used) + ' of ' + Math.round(W) + 'px (an empty slot)'); });
  });
  return { problems: problems.slice(0, 6), grids };
});

/**
 * An expanded row never moves the columns: every column's width is the same collapsed, with the first row open and
 * with every row open (±1 px); the table stays as wide as its box; the panel lies within the table; the primary
 * (flexible) column is never narrower than a quarter of the table.
 */
export const expandStability = (frame) => frame.evaluate(async () => {
  const problems = []; let tables = 0;
  const widths = (t) => Array.from(t.tHead ? t.tHead.querySelectorAll('th') : []).map((th) => Math.round(th.getBoundingClientRect().width));   // the outer header only (a nested table has its own)
  for (const t of Array.from(document.querySelectorAll('#diagnostics-content table.ui-fit'))) {
    const rows = Array.from(t.tBodies[0] ? t.tBodies[0].querySelectorAll(':scope > tr.ui-xrow') : []).filter((r) => r.offsetParent !== null);
    if (!rows.length) continue;
    tables += 1;
    const id = t.id || 'table.' + (t.className || '').split(/\s+/).slice(0, 2).join('.');
    const wrap = t.parentElement;
    rows.forEach((r) => window.diagTables.open(r, false));
    await new Promise((r) => setTimeout(r, 80));
    const closed = widths(t), tw0 = Math.round(t.getBoundingClientRect().width);
    const flexTh = t.querySelector('thead th.ui-col-flex, thead th.ui-col-wrap, thead th.ui-col-clamp');
    if (flexTh && flexTh.getBoundingClientRect().width < 0.24 * tw0) problems.push(id + ': the primary column is ' + Math.round(flexTh.getBoundingClientRect().width) + 'px of ' + tw0 + ' (under a quarter)');
    window.diagTables.open(rows[0], true);
    await new Promise((r) => setTimeout(r, 120));
    const one = widths(t);
    const diff1 = one.map((w, i) => Math.abs(w - closed[i]) > 1 ? i : -1).filter((i) => i >= 0);
    if (diff1.length) problems.push(id + ': opening the first row moved columns ' + diff1.join(', ') + ' (' + diff1.map((i) => closed[i] + '->' + one[i]).join(', ') + ')');
    const panel = rows[0].nextElementSibling;
    if (panel && panel.classList.contains('ui-xrow-panel')) { const pr = panel.getBoundingClientRect(), tr = t.getBoundingClientRect(); if (pr.right > tr.right + 1 || pr.left < tr.left - 1) problems.push(id + ': the panel runs past the table'); const cell = panel.querySelector('td'); if (cell && Math.abs(cell.getBoundingClientRect().width - tr.width) > 2) problems.push(id + ': the panel cell is ' + Math.round(cell.getBoundingClientRect().width) + 'px wide, the table ' + Math.round(tr.width)); }
    rows.forEach((r) => window.diagTables.open(r, true));
    await new Promise((r) => setTimeout(r, 120));
    const all = widths(t);
    const diffAll = all.map((w, i) => Math.abs(w - closed[i]) > 1 ? i : -1).filter((i) => i >= 0);
    if (diffAll.length) problems.push(id + ': opening every row moved columns ' + diffAll.join(', '));
    if (Math.abs(t.getBoundingClientRect().width - wrap.clientWidth) > 2 && !t.classList.contains('ui-wide')) problems.push(id + ': the table is ' + Math.round(t.getBoundingClientRect().width) + 'px wide in a ' + wrap.clientWidth + 'px box');
    rows.forEach((r) => window.diagTables.open(r, false));
  }
  return { problems: problems.slice(0, 8), tables };
});

/**
 * Nested tables (inside an expanded row's details) span the panel's content box (±2 px), with the room shared
 * across the columns: no column takes more than 40% unless it is the only text column, and no column leaves more
 * than a quarter of the table empty between its content and the next column.
 */
export const nestedTables = (frame) => frame.evaluate(async () => {
  const problems = []; let tables = 0;
  const openRows = Array.from(document.querySelectorAll('#diagnostics-content table.ui-fit > tbody > tr.ui-xrow')).filter((r) => r.offsetParent !== null).slice(0, 3);
  openRows.forEach((r) => window.diagTables.open(r, true));
  await new Promise((r) => setTimeout(r, 150));
  for (const t of Array.from(document.querySelectorAll('#diagnostics-content .ui-xrow-body table'))) {
    if (!t.getBoundingClientRect().width) continue;
    tables += 1;
    const id = (t.closest('table.ui-fit:not(.ui-compact)') || {}).id || 'nested';
    const body = t.closest('.ui-xrow-body'); const bs = getComputedStyle(body);
    const panelW = body.getBoundingClientRect().width - (parseFloat(bs.paddingLeft) || 0) - (parseFloat(bs.paddingRight) || 0);
    const tw = t.getBoundingClientRect().width;
    if (Math.abs(tw - panelW) > 4 && !t.classList.contains('ui-wide')) problems.push(id + ': the nested table is ' + Math.round(tw) + 'px wide in a ' + Math.round(panelW) + 'px panel');
    const ths = Array.from(t.querySelectorAll('thead th'));
    const rows = Array.from(t.tBodies[0] ? t.tBodies[0].rows : []).slice(0, 40);
    // a compact column: the fit's ui-col-num / status / icon, or a table.ui-nested's own kinds (ui-num, ui-status)
    const compact = (th) => /\bui-col-(num|status|icon)\b/.test(th.className) || /\b(ui-num|ui-status)\b/.test(th.className);
    const nested = t.classList.contains('ui-nested');
    const textCols = ths.filter((th) => !compact(th)).length;
    const range = document.createRange();
    ths.forEach((th, i) => {
      const colW = th.getBoundingClientRect().width;
      if (colW > 0.4 * tw + 1 && !(textCols === 1 && !compact(th))) problems.push(id + ': column "' + th.textContent.trim().slice(0, 12) + '" takes ' + Math.round(100 * colW / tw) + '% of the table');
      let max = 0;
      [th].concat(rows.map((r) => r.cells[i]).filter(Boolean)).forEach((c) => { range.selectNodeContents(c); const w = range.getBoundingClientRect().width; if (w > max) max = w; });
      // the one flexing text column of a ui-nested table takes the room its short content leaves: that is its job
      if (colW - max > 0.25 * tw + 20 && !(nested && /\bui-text\b/.test(th.className))) problems.push(id + ': column "' + th.textContent.trim().slice(0, 12) + '" leaves ' + Math.round(colW - max) + 'px empty');
    });
    // a number, a status or a lone badge keeps to one line (never a character per line in a starved column)
    Array.from(t.querySelectorAll('td')).slice(0, 240).forEach((td) => {
      if (!td.getBoundingClientRect().width || !td.textContent.trim()) return;
      const lone = td.children.length === 1 && /\bui-badge\b/.test(td.firstElementChild.className) && !td.textContent.replace(td.firstElementChild.textContent, '').trim();
      if (!/\b(ui-num|ui-col-num|ui-status|ui-col-status|bl-num)\b/.test(td.className) && !lone) return;
      const cs = getComputedStyle(td); const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 18;
      const rg = document.createRange(); rg.selectNodeContents(td); const h = rg.getBoundingClientRect().height;
      if (h > lh * 1.6) problems.push(id + ': a number / status cell on ' + Math.round(h / lh) + ' lines ("' + td.textContent.trim().slice(0, 20) + '")');
    });
  }
  openRows.forEach((r) => window.diagTables.open(r, false));
  return { problems: problems.slice(0, 8), tables };
});

/** Every horizontal bar chart's category labels lie fully inside the canvas (no label loses its first letters). */
export const yLabelsInside = (frame) => frame.evaluate(() => {
  const problems = []; let charts = 0;
  Object.values(window.Chart && Chart.instances ? Chart.instances : {}).forEach((c) => {
    if (!c.canvas || !c.canvas.isConnected || c.options.indexAxis !== 'y' || !c.scales.y) return;
    charts += 1;
    const s = c.scales.y; const items = s._labelItems || []; const ctx = c.ctx;
    ctx.save(); items.forEach((it) => { ctx.font = it.font && it.font.string ? it.font.string : ctx.font; const label = Array.isArray(it.label) ? it.label.join(' ') : String(it.label); const w = ctx.measureText(label).width; const x = it.translation ? it.translation[0] : 0; const left = it.textAlign === 'right' ? x - w : it.textAlign === 'center' ? x - w / 2 : x; if (left < -0.5) problems.push((c.canvas.id || 'chart') + ': "' + label.slice(0, 20) + '" starts ' + Math.round(-left) + 'px outside the canvas'); }); ctx.restore();
  });
  return { problems: problems.slice(0, 6), charts };
});

/**
 * An opened row's details never clip: no element inside the panel scrolls sideways (the code / YAML scrollers and a
 * nested table's own box excepted) and no value is cut (its rendered text is its whole text).
 */
export const panelClipping = (frame) => frame.evaluate(async () => {
  const problems = []; let panels = 0;
  const rows = Array.from(document.querySelectorAll('#diagnostics-content table > tbody > tr.ui-xrow')).filter((r) => r.offsetParent !== null).slice(0, 2);
  for (const r of rows) {
    window.diagTables.open(r, true); await new Promise((d) => setTimeout(d, 120));
    const panel = r.nextElementSibling; if (!panel || !panel.classList.contains('ui-xrow-panel')) continue;
    panels += 1;
    const id = (r.closest('table') || {}).id || 'table';
    Array.from(panel.querySelectorAll('*')).forEach((el) => {
      if (el.closest('pre, code, .ui-yaml, .ui-table-wrap, canvas, svg')) return;
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) problems.push(id + ': ' + el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(/\s+/)[0] + ' scrolls sideways (' + el.scrollWidth + ' > ' + el.clientWidth + ') "' + el.textContent.trim().slice(0, 24) + '"');
      const cs = getComputedStyle(el);
      if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth) problems.push(id + ': a value is cut with an ellipsis "' + el.textContent.trim().slice(0, 24) + '"');
    });
    { const body = panel.querySelector('.ui-xrow-body'); const cell = panel.querySelector('td'); if (body && cell) { const bs = getComputedStyle(body), cs2 = getComputedStyle(cell); const cellRight = cell.getBoundingClientRect().right - (parseFloat(cs2.paddingRight) || 0); const bodyRight = body.getBoundingClientRect().right; if (bodyRight > cellRight + 1) problems.push(id + ': the details body runs ' + Math.round(bodyRight - cellRight) + 'px past its cell'); const right = Math.min(bodyRight - (parseFloat(bs.paddingRight) || 0), cellRight); Array.from(body.children).forEach((ch) => { if (ch.getBoundingClientRect().right > right + 1) problems.push(id + ': ' + ch.tagName.toLowerCase() + '.' + (ch.className || '').toString().split(/\s+/)[0] + ' runs ' + Math.round(ch.getBoundingClientRect().right - right) + 'px past the panel'); }); } }
    Array.from(panel.querySelectorAll('dd')).forEach((dd) => { const range = document.createRange(); range.selectNodeContents(dd); const rr = range.getBoundingClientRect(), dr = dd.getBoundingClientRect(); if (rr.right > dr.right + 1) problems.push(id + ': the value "' + dd.textContent.trim().slice(0, 24) + '" runs past its cell'); });
    window.diagTables.open(r, false);
  }
  return { problems: problems.slice(0, 8), panels };
});

/**
 * Code blocks: every block's copy button lies inside the block with a 6 px inset, no bigger than 28 px, clear of the
 * text; a click writes the block's exact text (the clipboard stubbed) and shows the copied state.
 */
export const codeBlocks = (frame) => frame.evaluate(async () => {
  const problems = []; let blocks = 0;
  const rows = Array.from(document.querySelectorAll('#diagnostics-content table > tbody > tr.ui-xrow')).filter((r) => r.offsetParent !== null).slice(0, 2);
  rows.forEach((r) => window.diagTables.open(r, true));
  await new Promise((d) => setTimeout(d, 120));
  const written = [];
  const origClip = navigator.clipboard && navigator.clipboard.writeText;
  try { if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: (t) => { written.push(t); return Promise.resolve(); } }); } catch { /* read-only */ }
  const origExec = document.execCommand; document.execCommand = (cmd) => { if (cmd === 'copy') { const sel = document.activeElement; if (sel && sel.value !== undefined) written.push(sel.value); } return true; };
  for (const box of Array.from(document.querySelectorAll('#diagnostics-content .ui-code'))) {
    if (!box.offsetParent || box.closest('details:not([open])')) continue;   // a block inside a closed fold is not on view (its boxes still measure in Chromium)
    blocks += 1;
    const b = box.querySelector('.ui-code-copy'), pre = box.querySelector('pre');
    if (!b || !pre) { problems.push('a block without its button or text'); continue; }
    // the hit test reads the pane's view: the block brought into it first (the app scrolls the pane; the frame itself never scrolls)
    if (window.diagnosticsScrollTo) { window.diagnosticsScrollTo(box.getBoundingClientRect().top + window.scrollY - 60); await new Promise((d) => setTimeout(d, 200)); } else { try { box.scrollIntoView({ block: 'center' }); } catch { /* older */ } }
    const br = b.getBoundingClientRect(), xr = box.getBoundingClientRect(), pr = getComputedStyle(pre);
    if (br.width > 28 || br.height > 28) problems.push('a copy button of ' + Math.round(br.width) + 'x' + Math.round(br.height) + 'px');
    if (br.right > xr.right - 5 || br.top < xr.top + 5 || br.left < xr.left || br.bottom > xr.bottom) problems.push('the copy button is not inset in its block (right gap ' + Math.round(xr.right - br.right) + ', top gap ' + Math.round(br.top - xr.top) + ')');
    if (parseFloat(pr.paddingRight) < br.width + 10) problems.push('the text is not padded clear of the button (' + pr.paddingRight + ')');
    if (!b.getAttribute('aria-label') && !b.title) problems.push('the copy button has no name');
    // seen without hovering: the button answers at its centre and reads at more than half opacity
    { const vp = window.diagnosticsViewport; const inView = !vp || (br.top >= vp.top - 1 && br.bottom <= vp.top + vp.height + 1); const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2); const op = parseFloat(getComputedStyle(b).opacity); if (inView && (!hit || !(hit === b || b.contains(hit)))) problems.push('the copy button is covered at its centre by ' + (hit ? hit.tagName.toLowerCase() + '.' + String(hit.getAttribute('class') || '').split(/\s+/)[0] : 'nothing') + ' [btn ' + Math.round(br.left) + ',' + Math.round(br.top) + ' ' + Math.round(br.width) + 'x' + Math.round(br.height) + ' box ' + Math.round(xr.top) + '-' + Math.round(xr.bottom) + ' inner ' + innerWidth + 'x' + innerHeight + ' vp ' + JSON.stringify(vp) + ' hitRect ' + (hit ? Math.round(hit.getBoundingClientRect().top) + '-' + Math.round(hit.getBoundingClientRect().bottom) : '-') + ' details ' + (box.closest('details') ? box.closest('details').open : 'none') + ']'); if (!(op > 0.5)) problems.push('the copy button sits at opacity ' + op); }
    written.length = 0; b.click(); await new Promise((d) => setTimeout(d, 50));
    const text = b.getAttribute('data-copy') || pre.textContent;
    if (!written.length || written[written.length - 1] !== text) problems.push('the click did not write the block text (' + (written.length ? 'wrote ' + String(written[written.length - 1]).slice(0, 30) : 'nothing') + ')');
    if (!b.classList.contains('ui-copied') || !b.querySelector('svg path[d^="M20 6"]')) problems.push('no copied state (the check icon) after the click');
  }
  document.execCommand = origExec;
  try { if (navigator.clipboard && origClip) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: origClip }); } catch { /* fine */ }
  rows.forEach((r) => window.diagTables.open(r, false));
  return { problems: problems.slice(0, 8), blocks };
});

/**
 * Empty boxes: after the Findings strip, no visible element with a border, a background or a shadow that carries
 * no text and no control / chart / table (an empty card or panel left by a no-data branch). The outermost only;
 * tracks, bars, dots and chips (decorative boxes by design) and anything under 14 px are not counted.
 */
export const emptyBoxes = (frame) => frame.evaluate(() => {
  const root = document.querySelector('#diagnostics-content') || document.body;
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '');
  const strip = root.querySelector('.ui-findings');
  const boxes = Array.from(root.querySelectorAll('*')).filter((el) => {
    if (!vis(el) || el === strip || (strip && strip.contains(el))) return false;
    if (strip && !(strip.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    if (el.matches('input, select, button, textarea, summary, label, a, [role="button"]')) return false;   // a control is a box with a job
    if (el.matches('td, th')) return false;   // a table's cell (an empty value, the chevron column's header) is not a box of its own
    const cs = getComputedStyle(el);
    const boxed = (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') || !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) || cs.boxShadow !== 'none';
    if (!boxed || el.getBoundingClientRect().height < 14) return false;
    if (/\b(ui-meter\S*|ui-bar|lc-stack\S*|lc-c\d+|\S*track|\S*swatch|\S*dot|ui-chip\S*|\S*badge\S*|\S*progress\S*|\S*slider\S*|ui-pager)\b/.test(el.className)) return false;
    if (el.textContent.trim()) return false;
    if (el.querySelector('input, select, button, canvas, svg, img, textarea, table, [role="img"]')) return false;
    return true;
  });
  return boxes.filter((b) => !boxes.some((o) => o !== b && o.contains(b))).map((b) => name(b) + ' ' + Math.round(b.getBoundingClientRect().height) + 'px').slice(0, 8);
});

/** The page is the Findings strip alone: its visible top-level children, the first finding's text, the controls. */
export const stripOnly = (frame) => frame.evaluate(() => {
  const root = document.querySelector('#diagnostics-content') || document.body;
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '');
  const kids = Array.from(root.children).filter(vis);
  const f = root.querySelector('.ui-finding');
  return { kids: kids.map(name), strip: kids.length === 1 && kids[0].classList.contains('ui-findings'), findings: root.querySelectorAll('.ui-finding').length, text: f ? f.textContent.replace(/\s+/g, ' ').trim() : '', controls: root.querySelectorAll('input, select, button, canvas, table').length };
});
/** The clickable charts of the page: [{ id, horizontal, bars: [{ i, x, y, key, label, other }] }] (bar centres in frame coordinates). */
export const clickableCharts = (frame) => frame.evaluate(() => Object.values(window.Chart && Chart.instances ? Chart.instances : {}).filter((c) => c.canvas && c.canvas.isConnected && c.config && c.config._config && c.config._config.onPick && c.canvas.getBoundingClientRect().width > 0).map((c) => {
  const r = c.canvas.getBoundingClientRect();
  const meta = c.getDatasetMeta(0);
  const keys = c.data.keys || [], others = c.data.others || [], rows = c.$diagRows || [];
  const bars = meta.data.map((b, i) => {
    const horizontal = c.options.indexAxis === 'y';
    const x = horizontal ? (b.base + b.x) / 2 : b.x, y = horizontal ? b.y : (b.base + b.y) / 2;
    const raw = c.data.datasets[0].data[i];
    const label = c.data.labels ? c.data.labels[i] : (raw && raw.label);
    const key = keys[i] !== undefined ? keys[i] : (rows[i] && rows[i].key !== undefined ? rows[i].key : label);
    return { i, x: r.left + x + window.scrollX, y: r.top + y + window.scrollY, px: x, py: y, key, label, other: !!(others[i] || (rows[i] && rows[i].other)), width: horizontal ? Math.abs(b.x - b.base) : b.width, height: horizontal ? b.height : Math.abs(b.y - b.base) };
  });
  return { id: c.canvas.id, horizontal: c.options.indexAxis === 'y', bars };
}));
/** The pick the shared resolver recorded on the canvas after a click (null when the click hit nothing clickable). */
export const lastPick = (frame, id) => frame.evaluate((id) => { const c = document.getElementById(id); const p = c && c.$lastPick; return p ? { index: p.index, key: p.key, label: p.label, value: p.value } : null; }, id);
/** The control radius in the frame: every .btn and pager button is 8 px round, every chip a pill. */
export const controlRadius = (frame) => frame.evaluate(() => {
  const problems = []; let buttons = 0, chips = 0;
  document.querySelectorAll('#diagnostics-content .btn, #diagnostics-content .ui-pager button, #diagnostics-content .ui-input, #diagnostics-content .ui-select').forEach((b) => {
    if (!b.offsetParent) return; buttons += 1;
    const r = getComputedStyle(b).borderRadius;
    if (r !== '8px') problems.push((b.id ? '#' + b.id : b.tagName.toLowerCase() + '.' + (b.className || '').toString().split(/\s+/)[0]) + ' "' + (b.textContent || b.placeholder || '').trim().slice(0, 16) + '" radius ' + r);
  });
  document.querySelectorAll('#diagnostics-content .ui-chip').forEach((c) => { if (!c.offsetParent) return; chips += 1; const r = parseFloat(getComputedStyle(c).borderRadius); if (!(r >= 100)) problems.push('chip "' + c.textContent.trim().slice(0, 12) + '" radius ' + r); });
  return { problems: problems.slice(0, 8), buttons, chips };
});
