// evalfile payload for tests/diagnostics-live-driver.mjs (MAIN page).
//
// Force the diagnostics iframe to a small height, simulating the load-time
// window where the iframe's height has NOT yet caught up with its content
// (before the first height postMessage lands / between interval ticks). The
// bootstrap only re-posts when body height CHANGES, and body height is
// independent of iframe height (html/body are height:auto), so this stays
// forced until iframe_restore_height.js. Then measure inside the frame with
// scrollbar_classic_measure.js.
(() => {
  const f = document.querySelector('iframe[title="Diagnostics content"]');
  if (!f) return 'NO IFRAME';
  window.__origIframeH = f.style.height;
  f.style.height = '300px';
  return 'forced 300px (was ' + (window.__origIframeH || '(unset)') + ')';
})()
