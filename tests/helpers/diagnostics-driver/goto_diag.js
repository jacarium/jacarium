// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const els = [...document.querySelectorAll('button, [role="button"], a')];
  const el = els.find(e => {
    const t = e.getAttribute('title') || e.getAttribute('aria-label') || e.textContent.trim();
    return t === 'Diagnostics';
  });
  if (!el) return 'NOT_FOUND';
  el.click();
  return 'clicked Diagnostics';
})()
