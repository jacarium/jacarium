// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(async () => {
  const out = {};
  // 1. Sandbox isolation
  out.ownElectronAPI = typeof window.electronAPI;
  try { out.parentElectronAPI = String(!!parent.electronAPI); } catch (e) { out.parentElectronAPI = 'THROWS: ' + e.name; }
  try { out.topElectronAPI = String(!!top.electronAPI); } catch (e) { out.topElectronAPI = 'THROWS: ' + e.name; }
  try { out.origin = document.location.origin; } catch { out.origin = 'ERR'; }
  // 2. Chart.js loaded in frame
  out.chartDefined = typeof window.Chart;
  out.canvasPainted = (() => { const c = document.querySelector('canvas'); return c ? c.width > 0 && c.height > 0 : 'no canvas'; })();
  // 3. Tailwind CSS applied (a px-4 cell should have 16px padding-left)
  const td = document.querySelector('td.px-4');
  out.tailwindPx4 = td ? getComputedStyle(td).paddingLeft : 'no td';
  // 4. Auth proxy: allowlisted path round-trips (any HTTP status proves the
  //    parent proxied it); non-allowlisted path must be refused by the parent.
  try {
    const r = await window.diagnosticsApiRequest('/get_log_date_range', { directory: '/tmp/diag-reports/sosreport-synthetic-2026' });
    out.proxyAllowlisted = 'ok=' + r.ok + ' status=' + r.status;
  } catch (e) { out.proxyAllowlisted = 'REJECTED: ' + e.message; }
  try {
    const r2 = await window.diagnosticsApiRequest('/api/execute-ssh', { cmd: 'id' });
    out.proxyForbidden = 'NOT REFUSED: ok=' + r2.ok + ' status=' + r2.status;
  } catch (e) { out.proxyForbidden = 'refused: ' + e.message; }
  return out;
})()
