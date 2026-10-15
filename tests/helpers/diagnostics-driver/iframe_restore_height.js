// evalfile payload for tests/diagnostics-live-driver.mjs (MAIN page).
// Undo iframe_force_small.js.
(() => {
  const f = document.querySelector('iframe[title="Diagnostics content"]');
  if (!f) return 'NO IFRAME';
  f.style.height = window.__origIframeH || '';
  return 'restored ' + f.style.height;
})()
