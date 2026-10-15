// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const rows = [...document.querySelectorAll('table tbody tr')];
  const visible = rows.filter(r => r.style.display !== 'none').length;
  return {
    origin: (() => { try { return document.location.origin; } catch { return 'ERR'; } })(),
    bodyScrollH: document.body && document.body.scrollHeight,
    docElScrollH: document.documentElement.scrollHeight,
    innerW: window.innerWidth,
    bodyClientW: document.body.clientWidth,
    contentW: (document.getElementById('diagnostics-content') || {}).scrollWidth,
    tables: document.querySelectorAll('table').length,
    rows: rows.length,
    visibleRows: visible,
    pagButtons: [...document.querySelectorAll('[id*="agination"] button')].map(b => b.textContent.trim() + (b.className.includes('current-page') ? '*' : '')).slice(0, 12),
    hScrollers: [...document.querySelectorAll('.overflow-x-auto')].map(d => ({ cw: d.clientWidth, sw: d.scrollWidth })),
  };
})()
