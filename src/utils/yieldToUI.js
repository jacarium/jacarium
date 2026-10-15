/**
 * Cooperative yielding for long-running renderer work (exports).
 *
 * Every export in this app runs on the renderer's main thread (IndexedDB
 * reads, base64 conversion, JSON.stringify, JSZip). A tight loop of
 * awaits on already-resolved promises never gives React a chance to commit
 * a progress update, let alone lets the compositor paint it - the window
 * just freezes until the loop is done. These helpers insert real event-loop
 * turns between chunks of work so the progress modal actually animates.
 */

/**
 * Resolve after React has had a chance to commit pending state AND the
 * browser has painted a frame.
 *
 * requestAnimationFrame fires right before the next paint; the nested
 * setTimeout(0) resumes us right AFTER that paint. React 18 schedules its
 * render via a MessageChannel task that was posted before our rAF was
 * requested, so it runs first and the painted frame includes the update.
 * A fallback timer covers the case where rAF is throttled or paused
 * (hidden/background window) so a caller can never hang on it.
 *
 * @returns {Promise<void>}
 */
export function yieldToUI() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fallback = setTimeout(finish, 50);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        clearTimeout(fallback);
        setTimeout(finish, 0);
      });
    }
  });
}

/**
 * Create a time-budgeted yielder: `await maybeYield()` inside a hot loop
 * only actually yields once at least `budgetMs` of work has run since the
 * last yield. A yield costs roughly a frame (~10-16ms), so yielding on every
 * iteration of a many-thousand-item loop would multiply the export time;
 * the budget keeps the overhead bounded (~15-20% at the 50ms default) while
 * still repainting progress several times a second.
 *
 * @param {number} budgetMs - Minimum work time between yields
 * @returns {() => Promise<void>}
 */
export function createYielder(budgetMs = 50) {
  let last = performance.now();
  return async function maybeYield() {
    if (performance.now() - last < budgetMs) return;
    await yieldToUI();
    last = performance.now();
  };
}
