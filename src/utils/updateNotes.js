import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * The release check's renderer-side helpers (the check itself runs in the
 * Electron main process, electron/update-check.cjs, or on a self-hosted
 * server, backend/update_check.py).
 */

/** Window event that opens the "A new version is available" window with a status in `detail`. */
export const UPDATE_AVAILABLE_EVENT = 'showUpdateAvailable';

/**
 * Safe HTML of the release notes: GitHub release bodies are Markdown from
 * CHANGELOG.md, but they arrive from the network, so they go through the
 * same marked + DOMPurify path as every other outside Markdown, with no
 * images or embedded content, and every link made to open outside the app
 * (http(s) only; anything else loses its href).
 */
export function renderNotes(markdown) {
  const html = DOMPurify.sanitize(marked.parse(String(markdown || ''), { async: false }), {
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input', 'svg', 'math'],
    FORBID_ATTR: ['style'],
  });
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  for (const a of doc.querySelectorAll('a')) {
    const href = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) { a.removeAttribute('href'); continue; }
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  return doc.body.firstChild ? doc.body.firstChild.innerHTML : '';
}
