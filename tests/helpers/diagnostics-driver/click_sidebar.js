// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const label = window.__clickLabel;
  // Sidebar tabs/sub-tabs are divs with cursor-pointer containing a span with the label
  const spans = [...document.querySelectorAll('div.cursor-pointer span')];
  const span = spans.find(s => s.textContent.trim() === label);
  if (!span) return 'NOT_FOUND ' + label + ' (have: ' + spans.map(s => s.textContent.trim()).slice(0, 30).join(', ') + ')';
  span.closest('div.cursor-pointer').click();
  return 'clicked ' + label;
})()
