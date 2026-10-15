// fevalfile payload for tests/diagnostics-live-driver.mjs (diagnostics FRAME).
//
// Simulates a non-overlay-scrollbar machine (Windows / some Linux DEs) on
// macOS: styling ::-webkit-scrollbar switches Chromium to CUSTOM scrollbars,
// which reserve layout space exactly like classic scrollbars do. Then records
// baseline geometry. Pair with iframe_force_small.js (parent) and
// scrollbar_classic_measure.js (frame) to prove/disprove that a stale-small
// iframe height makes the frame's own document grow a width-stealing internal
// vertical scrollbar.
(() => {
  if (!document.getElementById('__classicScrollbars')) {
    const st = document.createElement('style');
    st.id = '__classicScrollbars';
    st.textContent = '::-webkit-scrollbar { width: 14px; height: 14px; } ::-webkit-scrollbar-thumb { background: #888; }';
    document.head.appendChild(st);
  }
  const de = document.documentElement;
  return {
    classicScrollbarsForced: true,
    innerWidth: window.innerWidth,
    htmlClientWidth: de.clientWidth,
    scrollbarGutterNow: window.innerWidth - de.clientWidth,
    htmlScrollHeight: de.scrollHeight,
    htmlClientHeight: de.clientHeight,
    bodyScrollHeight: document.body.scrollHeight,
    overflowHtml: getComputedStyle(de).overflowY,
    overflowBody: getComputedStyle(document.body).overflowY,
  };
})()
