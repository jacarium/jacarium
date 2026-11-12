import { useEffect, useRef } from 'react';
import { applyHiddenImages, restoreHiddenImages } from '../components/features/documents/hiddenImages';

/** Where user content shows images: markdown previews (documents, chat, descriptions) and marked reading areas. */
export const HIDDEN_IMAGE_SCOPE = '.markdown-preview, .ra-reading';

/**
 * "Hide images" everywhere (Settings > Accessibility): while `enabled`, one
 * observer on the document swaps every image inside user content for its
 * placeholder (hiddenImages.js) - after each render, coalesced to one pass
 * per animation frame, so the editor's keystrokes cost one cheap query.
 * Images shown again by their button stay shown for the session. Avatars,
 * icons and the brand mark are outside the scope and untouched.
 */
export default function useHiddenImages(enabled) {
  const revealed = useRef(new Set());
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    if (!enabled) { restoreHiddenImages(document.body); return undefined; }
    let raf = 0;
    const run = () => {
      raf = 0;
      for (const area of document.querySelectorAll(HIDDEN_IMAGE_SCOPE)) applyHiddenImages(area, revealed.current);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(run); };
    run();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); if (raf) cancelAnimationFrame(raf); restoreHiddenImages(document.body); };
  }, [enabled]);
}
