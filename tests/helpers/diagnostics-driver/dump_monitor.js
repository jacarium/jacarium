// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const wm = window.__wm;
  if (!wm) return 'NO MONITOR';
  const s = wm.samples;
  // Compact: show t, iframeW, iframeH, and per-container clientW/vScroll
  return s.slice(-120).map(r => {
    if (!('iframeW' in r)) return `${r.t}ms (no iframe)`;
    const c = (r.containers || []).map(x => `${x.cls.split(' ')[0]}:${x.clientW}${x.vScroll ? 'S' : ''}`).join(' ');
    return `${r.t}ms w=${r.iframeW} h=${r.iframeH} | ${c}`;
  }).join('\n');
})()
