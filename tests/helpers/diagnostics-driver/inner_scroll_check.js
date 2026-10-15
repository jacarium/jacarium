// fevalfile payload for tests/diagnostics-live-driver.mjs (diagnostics FRAME).
//
// Verify that templates' INTENTIONAL inner scroll panels (overflow-auto /
// overflow-y-auto sub-containers like the Log Viewer file list) still scroll
// after html/body were pinned to overflow:hidden - the fix must only kill the
// frame's own viewport scrollbar, never inner panels.
(() => {
  const els = [...document.querySelectorAll('*')].filter(el => {
    const oy = getComputedStyle(el).overflowY;
    return (oy === 'auto' || oy === 'scroll') && el !== document.body && el !== document.documentElement;
  });
  return els.slice(0, 10).map(el => {
    const scrollable = el.scrollHeight > el.clientHeight;
    let scrolled = null;
    if (scrollable) {
      const orig = el.scrollTop;
      el.scrollTop = 30;
      scrolled = el.scrollTop > 0;
      el.scrollTop = orig;
    }
    return {
      el: (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ').slice(0, 2).join('.')),
      scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
      currentlyScrollable: scrollable, scrollWorks: scrolled,
    };
  });
})()
