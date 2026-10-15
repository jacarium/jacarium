// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  // Find the scrolling container (the one with a vertical scrollbar) and
  // nudge it so macOS overlay scrollbars paint; report geometry of all
  // ancestors of the iframe plus window scrollbar widths.
  const f = document.querySelector('iframe[title="Diagnostics content"]');
  if (!f) return 'NO IFRAME';
  const out = { iframeH: f.getBoundingClientRect().height, layers: [] };
  let el = f.parentElement;
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el);
    if (/auto|scroll/.test(cs.overflowY) || /auto|scroll/.test(cs.overflow)) {
      out.layers.push({
        cls: (el.className || '').toString().slice(0, 45),
        clientW: el.clientWidth, offsetW: el.offsetWidth,
        scrollbarSpace: el.offsetWidth - el.clientWidth - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0),
        scrollH: el.scrollHeight, clientH: el.clientHeight,
      });
      el.scrollBy(0, 80);
    }
    el = el.parentElement;
  }
  return out;
})()
