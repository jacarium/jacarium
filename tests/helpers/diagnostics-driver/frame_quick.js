// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const rows = document.querySelectorAll('#cgroupTable tbody tr');
  let vis = 0; rows.forEach(r => { if (r.style.display !== 'none') vis++; });
  const ox = document.querySelector('.overflow-x-auto');
  const canvas = document.querySelector('canvas');
  return JSON.stringify({
    bodyH: document.body.scrollHeight,
    innerW: window.innerWidth,
    rows: rows.length,
    vis,
    oxClientW: ox && ox.clientWidth,
    oxScrollW: ox && ox.scrollWidth,
    canvasH: canvas && canvas.clientHeight,
    canvasW: canvas && canvas.clientWidth,
  });
})()
