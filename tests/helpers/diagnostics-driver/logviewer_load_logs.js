// fevalfile payload for tests/diagnostics-live-driver.mjs (diagnostics FRAME).
// Click Log Viewer's "Load Logs" button to kick off the streamed
// /parse_log_viewer_stream fetch through the parent auth proxy. Requires the
// fixture's journalctl file (make_fixture.py) and a Flask restart if the
// backend already cached this report directory without it.
(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Load Logs');
  if (!btn) return 'NO Load Logs BUTTON';
  btn.click();
  return 'clicked Load Logs';
})()
