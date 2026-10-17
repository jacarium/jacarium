// The row menu's dropdown placement on a phone (src/components/mobile/
// rowMenuAnchor.js): under the row when it fits, above it when it does
// not, else pinned in the band between the header and the bar with a
// max-height - and the announced row rectangle is taken once, soon.
import assert from 'node:assert/strict';
import { placeDropdown, announceRowMenu, takeRowMenuAnchor } from '../src/components/mobile/rowMenuAnchor.js';

let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`PASS: ${name}`); } catch (e) { failed++; console.log(`FAIL: ${name} | ${e.message}`); } };
const band = { top: 100, bottom: 780 };

check('a short menu opens 4px under the row', () => {
  const spot = placeDropdown({ anchor: { top: 200, bottom: 244 }, height: 150, ...band });
  assert.deepEqual(spot, { top: 248, maxHeight: null, placement: 'below' });
});
check('a row near the bar flips the menu above it', () => {
  const spot = placeDropdown({ anchor: { top: 700, bottom: 744 }, height: 150, ...band });
  assert.deepEqual(spot, { top: 546, maxHeight: null, placement: 'above' });
});
check('a menu taller than either side is pinned under the row with a max-height and scrolls', () => {
  const spot = placeDropdown({ anchor: { top: 300, bottom: 344 }, height: 900, ...band });
  assert.equal(spot.placement, 'pinned');
  assert.equal(spot.top, 348);
  assert.equal(spot.maxHeight, 772 - 348);
});
check('a tall menu from a row at the very bottom is pinned to the band instead', () => {
  const spot = placeDropdown({ anchor: { top: 700, bottom: 744 }, height: 900, ...band });
  assert.deepEqual(spot, { top: 108, maxHeight: 664, placement: 'pinned' });
});
check('an announced row rectangle is taken once', () => {
  announceRowMenu({ top: 1, bottom: 2, left: 3, right: 4 });
  assert.deepEqual(takeRowMenuAnchor(), { top: 1, bottom: 2, left: 3, right: 4 });
  assert.equal(takeRowMenuAnchor(), null);
});
check('a stale announcement is forgotten', () => {
  announceRowMenu({ top: 1, bottom: 2, left: 3, right: 4 });
  assert.equal(takeRowMenuAnchor(Date.now() + 5000), null);
});
console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
process.exit(failed ? 1 : 0);
