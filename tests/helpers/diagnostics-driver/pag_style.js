// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const cur = [...document.querySelectorAll('[id*="aginationControls"] button')].find(b => b.className.includes('current-page'));
  if (!cur) return 'NO CURRENT-PAGE BUTTON';
  const cs = getComputedStyle(cur);
  return {
    htmlDark: document.documentElement.classList.contains('dark'),
    page: cur.textContent.trim(),
    bg: cs.backgroundColor, border: cs.borderColor, color: cs.color, fontWeight: cs.fontWeight,
  };
})()
