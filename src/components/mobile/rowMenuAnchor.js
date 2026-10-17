/**
 * Where the next row menu belongs. The row chevron (RowMenuButton)
 * announces its row's rectangle just before it opens the row's context
 * menu; MobileMenuChrome, which places the menu as a dropdown under that
 * row when it appears, takes the announcement. One nobody took within a
 * moment is forgotten, so a menu opened another way (a long press) is
 * placed from its own pointer position instead.
 */
let pending = null;
const TTL_MS = 1500;

export function announceRowMenu(rect) {
  pending = rect ? { rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }, at: Date.now() } : null;
}

export function takeRowMenuAnchor(now = Date.now()) {
  const taken = pending;
  pending = null;
  if (!taken || now - taken.at > TTL_MS) return null;
  return taken.rect;
}

/**
 * The dropdown's place for a menu of `height` opened from `anchor`, inside
 * a viewport whose usable band runs from `top` (under the page header) to
 * `bottom` (above the bottom bar): under the row when it fits, above it
 * when it does not, else pinned in the band with a max-height and the menu
 * scrolling inside - as close under the row as the band allows. Pure, for
 * the tests.
 */
export function placeDropdown({ anchor, height, top, bottom, gap = 4, margin = 8 }) {
  const below = anchor.bottom + gap;
  if (below + height <= bottom - margin) return { top: below, maxHeight: null, placement: 'below' };
  const above = anchor.top - gap - height;
  if (above >= top + margin) return { top: above, maxHeight: null, placement: 'above' };
  const bandTop = top + margin;
  const bandBottom = bottom - margin;
  if (bandBottom - below >= 200) return { top: below, maxHeight: bandBottom - below, placement: 'pinned' };
  return { top: bandTop, maxHeight: bandBottom - bandTop, placement: 'pinned' };
}
