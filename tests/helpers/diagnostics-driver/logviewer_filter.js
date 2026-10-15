// fevalfile payload for tests/diagnostics-live-driver.mjs (diagnostics FRAME).
// Filter loaded Log Viewer entries down to the fixture's "example-updater"
// subset (40 of 200 rows) - pair with iframe_h.js before/after to verify the
// iframe height shrinks when Log Viewer content shrinks.
(() => {
  const inp = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').startsWith('Search logs'));
  if (!inp) return 'NO SEARCH INPUT';
  inp.value = 'example-updater';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return 'filtered: example-updater';
})()
