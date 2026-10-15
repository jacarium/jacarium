// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const inp = document.getElementById('processFilter');
  if (!inp) return 'NO FILTER INPUT';
  const before = document.body.scrollHeight;
  inp.value = 'example-daemon-042';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  const rows = [...document.querySelectorAll('#cgroupTable tbody tr')];
  const vis = rows.filter(r => r.style.display !== 'none').length;
  return { before, after: document.body.scrollHeight, visibleRows: vis,
           count: document.getElementById('filteredCount').textContent };
})()
