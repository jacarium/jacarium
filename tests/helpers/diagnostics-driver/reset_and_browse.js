// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const els = [...document.querySelectorAll('button, [role="button"], a')];
  const el = els.find(e => e.textContent.trim() === 'Load different report');
  if (!el) return 'NOT_FOUND reset';
  el.click();
  return 'clicked Load different report';
})()
