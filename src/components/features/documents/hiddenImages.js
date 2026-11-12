/**
 * "Hide images" (Settings > Accessibility, src/utils/readingAids.js): in the
 * live Markdown preview, each image gives way to a placeholder that names
 * it (its alt text) with a "Show image" button; the button brings that one
 * image back, and the choice is remembered for the document's session in
 * `revealed` (a Set of sources the caller keeps), so a re-render keeps the
 * image shown. The image element stays in the DOM, hidden (its attachment
 * resolution and lightbox behaviour are untouched); only the preview's DOM
 * changes - the document, the export and other readers are untouched.
 *
 * Idempotent: a run on a preview already treated changes nothing, so a
 * MutationObserver can call it after every render.
 */
const PLACEHOLDER = 'ra-image-placeholder';

function sourceOf(img) {
  return img.getAttribute('data-attachment') || img.getAttribute('src') || img.getAttribute('alt') || '';
}

/** Hide every image of `container` not yet hidden and not in `revealed`; returns how many placeholders were added. */
export function applyHiddenImages(container, revealed = new Set()) {
  if (!container) return 0;
  let added = 0;
  for (const img of Array.from(container.querySelectorAll('img'))) {
    if (img.hasAttribute('data-ra-hidden') || img.closest(`.${PLACEHOLDER}`)) continue;
    if (revealed.has(sourceOf(img))) continue;
    const doc = img.ownerDocument;
    const box = doc.createElement('span');
    box.className = PLACEHOLDER;
    box.setAttribute('role', 'group');
    box.setAttribute('data-testid', 'ra-image-placeholder');
    const alt = (img.getAttribute('alt') || '').trim();
    const text = doc.createElement('span');
    text.className = 'ra-image-alt';
    text.textContent = alt ? `Image: ${alt}` : 'Image (no description)';
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'ra-image-show';
    button.textContent = 'Show image';
    button.setAttribute('aria-label', alt ? `Show image: ${alt}` : 'Show image');
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();   // not a click on the preview (links, task boxes)
      revealed.add(sourceOf(img));
      img.removeAttribute('data-ra-hidden');
      img.hidden = false;
      box.remove();
    });
    box.append(text, button);
    img.setAttribute('data-ra-hidden', '');
    img.hidden = true;
    img.before(box);
    added++;
  }
  return added;
}

/** Put every hidden image back and drop the placeholders (the setting turned off). */
export function restoreHiddenImages(container) {
  if (!container) return;
  for (const box of Array.from(container.querySelectorAll(`.${PLACEHOLDER}`))) box.remove();
  for (const img of Array.from(container.querySelectorAll('img[data-ra-hidden]'))) {
    img.removeAttribute('data-ra-hidden');
    img.hidden = false;
  }
}
