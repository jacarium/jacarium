// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const f = document.querySelector('iframe[title="Diagnostics content"]');
  let el = f && f.parentElement;
  while (el) {
    if (el.scrollHeight > el.clientHeight + 10) { el.scrollTop = el.scrollHeight; return 'scrolled ' + (el.className || '').toString().slice(0, 30); }
    el = el.parentElement;
  }
  return 'no scroller';
})()
