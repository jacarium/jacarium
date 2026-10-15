// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const spans = [...document.querySelectorAll('div.cursor-pointer span')];
  const span = spans.find(s => s.textContent.trim() === 'System Activity Report');
  if (!span) return 'NOT_FOUND';
  const row = span.closest('div.cursor-pointer').parentElement;
  const chev = row.querySelector('button[title="Expand"]');
  if (chev) { chev.click(); }
  return [...document.querySelectorAll('div.cursor-pointer span')].map(s => s.textContent.trim());
})()
