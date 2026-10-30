/**
 * Escape in the Media Library, in jsdom over fake-indexeddb with the REAL
 * modal (tests/helpers/media-library-entry.mjs), now on the shared
 * BaseModal:
 *
 *   - Escape with nothing open inside closes the library (onClose), from
 *     anywhere - the search field included;
 *   - an inner layer closes first and the library stays: the ... menu, the
 *     preview lightbox, the tag editor (Escape typed in its own field), the
 *     delete confirmation; the next Escape closes the library;
 *   - in the Upload tab with pending rows, Escape (in a name field) cancels
 *     the rows and the library stays; the next Escape closes it; in replace
 *     mode: the pending row, then replace mode, then the library;
 *   - the focus goes back to the control that opened the library
 *     (`returnFocusTo`) when it closes.
 *
 * Run:  node tests/media-modal-escape.test.mjs   (needs jsdom + fake-indexeddb)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker, click, waitFor, chooseFile, sleep } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { mod, window } = await setupDocumentsEnv('media-modal-escape', { entry: path.join(here, 'helpers', 'media-library-entry.mjs') });
const { check, summary } = makeChecker();
const { document } = window;
const { uploadMedia } = mod.media;
const { db } = mod;

const q = (sel) => document.querySelector(sel);
const qa = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (target = document.activeElement || document.body) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const file = (name) => new window.File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' });

// the control that opened the library, as a page would have it
const opener = document.createElement('button');
opener.textContent = 'Media Library';
document.body.appendChild(opener);
let closed = 0;
const render = (props = {}) => mod.renderModal({ onClose: () => { closed += 1; }, returnFocusTo: () => opener, ...props });
const openBrowse = async () => {
  render();
  await waitFor(() => q('[data-testid="media-tab-browse"]'));
  click(window, q('[data-testid="media-tab-browse"]'));
  await waitFor(() => qa('button[title="Actions"]').length > 0);
};
const openMenu = () => { click(window, qa('button[title="Actions"]')[0]); return waitFor(() => q('[data-testid="media-context-menu"]')); };
const menuItem = (re) => qa('[data-testid="media-context-menu"] button').find((b) => re.test(b.textContent));

await db.media.clear();
await uploadMedia(file('pic.png'), { name: 'pic.png' });

// ---- nothing open inside: Escape closes ----
opener.focus();
await openBrowse();
check('the library is on the shared modal and holds the focus on open', !!q('.sc-modal-backdrop [data-testid="media-library"]') && q('.sc-modal-backdrop').contains(document.activeElement), document.activeElement && document.activeElement.tagName);
esc();
await sleep(10);
check('Escape with nothing open inside closes the library', closed === 1, String(closed));
const search = q('input[placeholder^="Search"]');
search.focus();
esc(search);
await sleep(10);
check('...from the search field as well (the same rule)', closed === 2, String(closed));

// ---- the ... menu first ----
await openMenu();
esc();
await sleep(10);
check('Escape closes the ... menu first, the library stays', !q('[data-testid="media-context-menu"]') && closed === 2 && !!q('[data-testid="media-library"]'));
esc();
await sleep(10);
check('...the next Escape closes the library', closed === 3);

// ---- the preview ----
click(window, q('[data-testid="media-library"] .aspect-square'));
await waitFor(() => q('[data-testid="media-preview"]'));
esc();
await sleep(10);
check('Escape closes the preview first', !q('[data-testid="media-preview"]') && closed === 3);

// ---- the tag editor, from its own field ----
await openMenu();
click(window, menuItem(/Edit Tags/));
await waitFor(() => q('[data-testid="media-tag-editor"] input'));
const tagField = q('[data-testid="media-tag-editor"] input');
tagField.focus();
esc(tagField);
await sleep(10);
check('Escape in the tag editor\'s field closes the editor only', !q('[data-testid="media-tag-editor"]') && closed === 3 && !!q('[data-testid="media-library"]'));

// ---- the delete confirmation ----
await openMenu();
click(window, menuItem(/Delete/));
await waitFor(() => /Delete Image/.test(document.body.textContent));
esc();
await sleep(10);
check('Escape closes the delete confirmation only', !/Delete Image/.test(document.body.textContent) && closed === 3);
check('(nothing was deleted)', (await db.media.count()) === 1);

// ---- pending rows first ----
click(window, q('[data-testid="media-tab-upload"]'));
await waitFor(() => q('[data-testid="media-upload-input"]'));
chooseFile(window, q('[data-testid="media-upload-input"]'), file('one.png'));
await waitFor(() => qa('[data-testid="media-pending-row"]').length === 1);
chooseFile(window, q('[data-testid="media-upload-input"]'), file('two.png'));
await waitFor(() => qa('[data-testid="media-pending-row"]').length === 2);
check('the first name field has the focus', document.activeElement === q('[data-testid="media-pending-name"]'));
esc(document.activeElement);
await waitFor(() => qa('[data-testid="media-pending-row"]').length === 0);
check('Escape in a name field cancels the pending rows, the library stays', qa('[data-testid="media-pending-row"]').length === 0 && closed === 3 && !!q('[data-testid="media-library"]'));
esc();
await sleep(10);
check('...the next Escape closes the library', closed === 4);
check('(nothing was uploaded)', (await db.media.count()) === 1);

// ---- replace mode: the row, then the mode, then the library ----
await openBrowse();
await openMenu();
click(window, menuItem(/Replace Image/));
await waitFor(() => q('[data-testid="media-replace-banner"]'));
chooseFile(window, q('[data-testid="media-upload-input"]'), file('new.png'));
await waitFor(() => qa('[data-testid="media-pending-row"]').length === 1);
click(window, q('[data-testid="media-upload-confirm"]'));
await waitFor(() => /Replace pic\.png\?/.test(document.body.textContent));
esc();
await sleep(10);
check('Escape closes the replace confirmation first', !/Replace pic\.png\?/.test(document.body.textContent) && qa('[data-testid="media-pending-row"]').length === 1 && closed === 4);
esc(document.activeElement);
await waitFor(() => qa('[data-testid="media-pending-row"]').length === 0);
check('...then cancels the pending row, replace mode stays', !!q('[data-testid="media-replace-banner"]') && closed === 4);
esc();
await sleep(10);
check('...then leaves replace mode, the library stays', !q('[data-testid="media-replace-banner"]') && !!q('[data-testid="media-library"]') && closed === 4);
esc();
await sleep(10);
check('...then closes the library', closed === 5);
check('(the image is untouched)', (await db.media.count()) === 1);

// ---- the focus goes back to the opener ----
render({ isOpen: false });
await sleep(30);
check('on close the focus is back on the control that opened the library', document.activeElement === opener, document.activeElement && document.activeElement.tagName);
mod.unmountModal();

summary();
