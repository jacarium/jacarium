// evalfile payload for tests/diagnostics-live-driver.mjs (MAIN page).
// Dump the records captured by height_msg_recorder.js. overflowWindow=true
// means that in the interval BEFORE this message the frame's content height
// (this message's value) exceeded the iframe's then-applied height (previous
// message's value; 120px iframe minHeight before the first message) - i.e.
// the frame's own document met the internal-scrollbar condition during that
// window. On a machine with space-reserving scrollbars that scrollbar steals
// content width until the height catches up - the reported load jitter.
(() => {
  const rec = window.__heightRecorder;
  if (!rec) return 'NO RECORDER - run height_msg_recorder.js first';
  const INITIAL_MIN_HEIGHT = 120; // iframe style minHeight
  let prev = INITIAL_MIN_HEIGHT;
  return rec.records.map(r => {
    const out = { ...r, prevAppliedHeight: prev, overflowWindow: r.reportedHeight > prev + 1 };
    prev = r.reportedHeight;
    return out;
  });
})()
