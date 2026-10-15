// fevalfile payload for tests/diagnostics-live-driver.mjs (diagnostics FRAME).
// Injects a temporary fixed-height overflow-y:auto panel and scrolls it -
// positive proof that nested inner scroll containers keep working while the
// frame's own html/body are pinned to overflow:hidden. Self-cleaning.
(() => {
  const d = document.createElement('div');
  d.style.cssText = 'height:100px;overflow-y:auto;';
  d.innerHTML = '<div style="height:1000px"></div>';
  document.body.appendChild(d);
  d.scrollTop = 50;
  const ok = d.scrollTop === 50;
  d.remove();
  return { innerPanelScrolls: ok };
})()
