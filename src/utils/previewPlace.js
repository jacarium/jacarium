/**
 * The reader's place in the Markdown preview: the preview's top-level
 * blocks carry `data-source-line` (src/utils/interactiveMarkdown.js
 * renderWithSourceLines, the preview path only), so DocumentEditor can
 * scroll the preview to the line that was at the top of the editor and the
 * editor to the block at the top of the preview. Binary searches: the
 * blocks are in document order, their lines and positions ascend, and a
 * huge preview has a hundred thousand of them.
 */

/**
 * The preview's block for a source line: the element whose data-source-line
 * is the greatest one not above `line` (the nearest preceding block), the
 * first block when every block is below the line, null without blocks.
 */
export function previewBlockForLine(container, line) {
  const blocks = container.querySelectorAll('[data-source-line]');
  if (!blocks.length) return null;
  let lo = 0, hi = blocks.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const n = Number(blocks[mid].getAttribute('data-source-line'));
    if (n <= line) { best = blocks[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best || blocks[0];
}

/**
 * The source line of the preview's top visible block (the first block whose
 * bottom is below the scroller's top edge), or null without blocks.
 */
export function previewTopVisibleLine(container) {
  const blocks = container.querySelectorAll('[data-source-line]');
  if (!blocks.length) return null;
  const top = container.getBoundingClientRect().top;
  let lo = 0, hi = blocks.length - 1, first = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].getBoundingClientRect().bottom > top + 1) { first = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return Number(blocks[first].getAttribute('data-source-line')) || null;
}

/** Scroll `container` so that `block` sits at its top edge. */
export function scrollPreviewToBlock(container, block) {
  container.scrollTop = Math.max(0, block.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop);
}
