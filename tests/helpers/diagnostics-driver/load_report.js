// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('sosreport-synthetic'));
  if (!btn) return 'REPORT_NOT_FOUND';
  btn.click();
  return 'clicked report';
})()
