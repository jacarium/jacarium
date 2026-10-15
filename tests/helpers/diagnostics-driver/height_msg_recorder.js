// evalfile payload for tests/diagnostics-live-driver.mjs (MAIN page).
//
// Install BEFORE clicking a diagnostics tab. Records every height postMessage
// arriving from the sandboxed iframe. NOTE: React's own listener (registered
// at mount, so it runs first) applies each height synchronously before this
// recorder sees the event - so iframeHeightAtArrival always equals the just-
// applied reportedHeight. The overflow proof therefore uses the PREVIOUS
// applied height (see height_msg_dump.js): between message N-1 and N the
// iframe sat at height h(N-1) while its content had already reached h(N); the
// first message's predecessor is the iframe's initial 120px minHeight. Any
// record with reportedHeight > prevAppliedHeight proves a window where the
// frame's content overflowed its own viewport - the internal-scrollbar
// condition (scrollHeight > clientHeight with overflow not hidden).
(() => {
  if (window.__heightRecorder) { window.__heightRecorder.records.length = 0; window.__heightRecorder.t0 = performance.now(); return 'recorder reset'; }
  const rec = { records: [], t0: performance.now() };
  window.__heightRecorder = rec;
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__diagnosticsIframe !== true || d.type !== 'height') return;
    const f = document.querySelector('iframe[title="Diagnostics content"]');
    rec.records.push({
      tMs: Math.round(performance.now() - rec.t0),
      reportedHeight: d.height,
      iframeHeightAtArrival: f ? Math.round(f.getBoundingClientRect().height) : null,
    });
  });
  return 'recorder installed';
})()
