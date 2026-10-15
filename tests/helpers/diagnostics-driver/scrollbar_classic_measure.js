// fevalfile payload for tests/diagnostics-live-driver.mjs (diagnostics FRAME).
//
// Run AFTER scrollbar_classic_baseline.js + iframe_force_small.js. With
// classic (space-reserving) scrollbars forced and the iframe stuck at a
// stale-small height:
//   - PRE-FIX  (overflow visible): expect scrollbarGutterNow ~14 (internal
//     vertical scrollbar appeared and stole content width - the reported
//     jitter mechanism) and the viewport programmatically scrollable.
//   - POST-FIX (overflow hidden on html/body): expect scrollbarGutterNow 0
//     and scrollYAfterScrollTo 0 (frame can never scroll internally).
(() => {
  const de = document.documentElement;
  const before = {
    innerWidth: window.innerWidth,
    htmlClientWidth: de.clientWidth,
    scrollbarGutterNow: window.innerWidth - de.clientWidth,
    htmlScrollHeight: de.scrollHeight,
    htmlClientHeight: de.clientHeight,
    overflowCondition: de.scrollHeight > de.clientHeight,
    overflowHtml: getComputedStyle(de).overflowY,
    overflowBody: getComputedStyle(document.body).overflowY,
  };
  window.scrollTo(0, 200);
  before.scrollYAfterScrollTo = window.scrollY;
  window.scrollTo(0, 0);
  return before;
})()
