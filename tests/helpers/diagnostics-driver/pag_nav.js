// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  // Click page "2", then report pagination state + current-page computed style
  const btns = [...document.querySelectorAll('[id*="aginationControls"] button')];
  const b2 = btns.find(b => b.textContent.trim() === '2');
  if (!b2) return 'NO PAGE-2 BUTTON';
  b2.click();
  const after = [...document.querySelectorAll('[id*="aginationControls"] button')];
  const cur = after.find(b => b.className.includes('current-page'));
  const cs = cur && getComputedStyle(cur);
  const rows = [...document.querySelectorAll('#cgroupTable tbody tr')];
  const vis = rows.filter(r => r.style.display !== 'none');
  const firstPid = vis[0] && vis[0].children[0].textContent.trim();
  return {
    buttons: after.map(b => b.textContent.trim() + (b.className.includes('current-page') ? '*' : '')),
    currentPageText: cur && cur.textContent.trim(),
    style: cs && { bg: cs.backgroundColor, border: cs.borderColor, borderW: cs.borderWidth, color: cs.color, fontWeight: cs.fontWeight },
    visRows: vis.length, firstVisiblePid: firstPid,
    countText: document.getElementById('filteredCount').textContent,
  };
})()
