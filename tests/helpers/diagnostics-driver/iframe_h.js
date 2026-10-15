// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const f = document.querySelector('iframe[title="Diagnostics content"]');
  return f ? { iframeStyleH: f.style.height, iframeRectH: Math.round(f.getBoundingClientRect().height) } : 'NO IFRAME';
})()
