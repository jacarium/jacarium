// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  const els = [...document.querySelectorAll('button, a, [role="button"], [title]')];
  return els
    .map(e => ({ t: e.getAttribute('title') || e.getAttribute('aria-label') || e.textContent.trim().slice(0, 30), tag: e.tagName }))
    .filter(x => /diag|sos|report/i.test(x.t))
    .slice(0, 10);
})()
