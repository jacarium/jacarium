// evalfile/fevalfile payload for tests/diagnostics-live-driver.mjs.
(() => {
  // Width/height jitter monitor: samples every animation frame, records only
  // changes. Watches the diagnostics iframe, its offsetParent chain widths,
  // and the two overflow-auto scroll containers.
  if (window.__wm && window.__wm.raf) cancelAnimationFrame(window.__wm.raf);
  const wm = { samples: [], t0: performance.now(), raf: null };
  window.__wm = wm;
  let last = '';
  function sample() {
    const f = document.querySelector('iframe[title="Diagnostics content"]');
    const rec = { t: Math.round(performance.now() - wm.t0) };
    if (f) {
      const r = f.getBoundingClientRect();
      rec.iframeW = Math.round(r.width * 100) / 100;
      rec.iframeH = Math.round(r.height);
      // walk up to find scroll containers
      let el = f.parentElement;
      const conts = [];
      while (el && el !== document.body) {
        const cs = getComputedStyle(el);
        if (/auto|scroll/.test(cs.overflowY) || /auto|scroll/.test(cs.overflow)) {
          conts.push({
            cls: (el.className || '').toString().slice(0, 40),
            clientW: el.clientW = el.clientWidth,
            offsetW: el.offsetWidth,
            vScroll: el.scrollHeight > el.clientHeight,
          });
        }
        el = el.parentElement;
      }
      rec.containers = conts;
    } else {
      rec.iframe = null;
    }
    const key = JSON.stringify({ ...rec, t: 0 });
    if (key !== last) { last = key; wm.samples.push(rec); }
    wm.raf = requestAnimationFrame(sample);
  }
  sample();
  return 'monitor installed';
})()
