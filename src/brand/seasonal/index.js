/**
 * The seasonal decorations of the mark and the rule that picks one.
 *
 * A decoration is one file in this directory exporting { id, name, window,
 * render }: `window` is { from: [month, day], to: [month, day] }, inclusive,
 * every year, and may wrap over the year's end (from December to January);
 * `render()` returns an SVG group in the mark's coordinate system (the
 * 120 x 120 box of src/brand/BrandMark.jsx, the arch at 22..98 x 16..110;
 * the group may extend beyond the box - the mark is drawn with overflow
 * visible when a decoration is on). Adding one: drop the file in here, add
 * it to DECORATIONS below, give it a window that does not overlap the
 * others (docs/HOW_TO_ADD_SEASONAL_DECORATION.md). Turning one off, or
 * forcing one: src/brand/seasonal/active.js.
 *
 * Overlapping windows: the first decoration in DECORATIONS wins
 * (deterministic; the windows here are chosen not to overlap).
 */
import { ACTIVE_DECORATION } from './active';
import pumpkin from './pumpkin';
import christmas from './christmas';
import newyear from './newyear';
import mayTheFourth from './may-the-fourth';

export const DECORATIONS = [pumpkin, christmas, newyear, mayTheFourth];

/** True when the local date (month 1-12, day) falls inside the window, wrap over New Year included. */
export function inWindow(window, date) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const now = m * 100 + d;
  const from = window.from[0] * 100 + window.from[1];
  const to = window.to[0] * 100 + window.to[1];
  if (from <= to) return now >= from && now <= to;
  return now >= from || now <= to;   // the window wraps: e.g. 28 Dec - 3 Jan
}

/**
 * The decoration to show for a local date: the override first ('none' ->
 * null, a decoration id -> that one), else the first decoration of the
 * registry whose window holds the date, else null. `registry` is injectable
 * for the tests.
 */
export function activeDecoration(date = new Date(), override = ACTIVE_DECORATION, registry = DECORATIONS) {
  if (override && override !== 'auto') {
    if (override === 'none') return null;
    return registry.find((d) => d.id === override) || null;
  }
  return registry.find((d) => inWindow(d.window, date)) || null;
}

/** The decoration with this id, or null. */
export function decorationById(id, registry = DECORATIONS) {
  return registry.find((d) => d.id === id) || null;
}
