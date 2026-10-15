// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const spans = [...document.querySelectorAll('div.cursor-pointer span')];
  const span = spans.find(s => s.textContent.trim() === 'Control Groups');
  if (!span) return 'NOT_FOUND Control Groups';
  const row = span.closest('div.cursor-pointer').parentElement;
  const chev = row.querySelector('button[title="Expand"]');
  if (chev) { chev.click(); return 'expanded Control Groups'; }
  return 'already expanded (no Expand button)';
})()
