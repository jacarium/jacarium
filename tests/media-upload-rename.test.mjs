/**
 * The Media Library's Upload tab, driven in jsdom over fake-indexeddb with
 * the REAL modal (tests/helpers/media-library-entry.mjs):
 *
 *   - the file picker and a drop no longer upload on the spot: each image
 *     becomes a pending row with a preview and an editable name field
 *     (prefilled with the file's own name, sanitised), focus on the first
 *     field; Upload stores them under the names in the fields, Cancel (and
 *     Escape) discards them;
 *   - Ctrl/Cmd+V with an image on the clipboard (a `paste` event carrying
 *     image files) adds a pending row named screenshot-YYYY-MM-DD-HHMMSS.png
 *     with the extension from the MIME type; Enter in the name field
 *     uploads; a text paste adds nothing and is left to whoever has focus
 *     (the search field keeps its default paste); a paste into the name
 *     field of a pending row with an image on the clipboard still adds the
 *     image (and does not drop binary into the field);
 *   - an invalid name shows the sanitiser's message inline and blocks Upload
 *     until fixed; a name the library already has shows what it will be
 *     stored as (name-2.png) and is stored so; two rows with the same name
 *     get -2 for the second;
 *   - the Browse tab lists what was stored, under the chosen names.
 *
 * Run:  node tests/media-upload-rename.test.mjs   (needs jsdom + fake-indexeddb:
 *                                                npm install --no-save jsdom fake-indexeddb)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker, click, waitFor, typeInto, chooseFile, dropFile, sleep } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { mod, window } = await setupDocumentsEnv('media-upload-rename', { entry: path.join(here, 'helpers', 'media-library-entry.mjs') });
const { check, summary } = makeChecker();
const { document } = window;
const { getAllMedia } = mod.media;
const { db } = mod;

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const file = (name, type = 'image/png') => new window.File([bytes], name, { type });
const q = (sel) => document.querySelector(sel);
const qa = (sel) => Array.from(document.querySelectorAll(sel));
const names = async () => (await getAllMedia()).map((m) => m.filename).sort();
const key = (el, k, extra = {}) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
// a paste event as the browser raises it: `clipboardData` with files / items (jsdom has no ClipboardEvent)
const paste = (target, { files = [], items = [], text = null } = {}) => {
  const ev = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { files, items, types: files.length ? ['Files'] : ['text/plain'], getData: (t) => (t === 'text/plain' ? text : '') } });
  target.dispatchEvent(ev);
  return ev;
};
const openUpload = async () => {
  mod.renderModal();
  await waitFor(() => q('[data-testid="media-tab-upload"]'));
  click(window, q('[data-testid="media-tab-upload"]'));
  await waitFor(() => q('[data-testid="media-upload-drop"]'));
};

await db.media.clear();
await openUpload();

// ---- the file picker: a pending row, rename, Upload ----
chooseFile(window, q('[data-testid="media-upload-input"]'), file('team photo.png'));
await waitFor(() => q('[data-testid="media-pending-name"]'));
let field = q('[data-testid="media-pending-name"]');
check('the picked file becomes a pending row with its name prefilled, sanitised', field && field.value === 'team_photo.png', field && field.value);
check('the first name field has focus', document.activeElement === field);
check('the row shows a preview image and the file size', !!q('[data-testid="media-pending-row"] img') && /B|KB/.test(q('[data-testid="media-pending-row"]').textContent));
check('no upload happened yet', (await names()).length === 0);
typeInto(window, field, 'diagram.png');
click(window, q('[data-testid="media-upload-confirm"]'));
await waitFor(async () => (await names()).length === 1);
check('Upload stores the image under the typed name', JSON.stringify(await names()) === '["diagram.png"]', (await names()).join(','));
await waitFor(() => !q('[data-testid="media-pending-row"]'));
check('the pending list is cleared and the just-uploaded preview names the stored file', !q('[data-testid="media-pending-row"]') && /diagram\.png/.test(q('[data-testid="media-upload-drop"]').parentElement.textContent));

// ---- a drop: two files, a duplicate hint, Enter uploads ----
dropFile(window, q('[data-testid="media-upload-drop"]'), file('diagram.png'));
await waitFor(() => q('[data-testid="media-pending-name"]'));
check('a dropped file whose name the library has shows the name it will be stored as', /diagram-2\.png/.test(q('[data-testid="media-pending-row"]').textContent), q('[data-testid="media-pending-row"]').textContent.slice(0, 200));
key(q('[data-testid="media-pending-name"]'), 'Enter');
await waitFor(async () => (await names()).length === 2);
check('Enter in the name field uploads, under the -2 name', JSON.stringify(await names()) === '["diagram-2.png","diagram.png"]', (await names()).join(','));

// ---- validation ----
chooseFile(window, q('[data-testid="media-upload-input"]'), file('x.png'));
await waitFor(() => q('[data-testid="media-pending-name"]'));
typeInto(window, q('[data-testid="media-pending-name"]'), '../escape.png');
await sleep(20);
check("an invalid name ('../escape.png') shows the sanitiser's message and disables Upload", /not allowed|cannot contain/.test(q('[data-testid="media-pending-row"]').textContent) && q('[data-testid="media-upload-confirm"]').disabled, q('[data-testid="media-pending-row"]').textContent.slice(0, 160));
typeInto(window, q('[data-testid="media-pending-name"]'), '');
await sleep(20);
check('an empty name is refused too', /required/i.test(q('[data-testid="media-pending-row"]').textContent) && q('[data-testid="media-upload-confirm"]').disabled);
typeInto(window, q('[data-testid="media-pending-name"]'), 'fixed.jpg');
await sleep(20);
check('a wrong extension is shown corrected to the image type (fixed.png) and Upload is enabled again', /fixed\.png/.test(q('[data-testid="media-pending-row"]').textContent) && !q('[data-testid="media-upload-confirm"]').disabled);
key(q('[data-testid="media-pending-name"]'), 'Escape');
await waitFor(() => !q('[data-testid="media-pending-row"]'));
check('Escape cancels the pending rows without uploading', !q('[data-testid="media-pending-row"]') && (await names()).length === 2);

// ---- paste ----
const stamp = /^screenshot-\d{4}-\d{2}-\d{2}-\d{6}\.png$/;
paste(document.body, { files: [file('whatever', 'image/png')] });
await waitFor(() => q('[data-testid="media-pending-name"]'));
field = q('[data-testid="media-pending-name"]');
check('a pasted image becomes a pending row named screenshot-YYYY-MM-DD-HHMMSS.png', stamp.test(field.value), field.value);
check('the pasted row says where it came from', /clipboard/i.test(q('[data-testid="media-pending-row"]').textContent));
check('the name field has focus after the paste', document.activeElement === field);
const pastedName = field.value;
key(field, 'Enter');
await waitFor(async () => (await names()).length === 3);
check('Enter uploads the pasted image under the screenshot name', (await names()).includes(pastedName), (await names()).join(','));
paste(document.body, { files: [file('shot.jpeg', 'image/jpeg')] });
await waitFor(() => q('[data-testid="media-pending-name"]'));
check('a pasted JPEG gets the .jpg extension', /^screenshot-.*\.jpg$/.test(q('[data-testid="media-pending-name"]').value), q('[data-testid="media-pending-name"]').value);
// a second paste while a row is pending, into the name field itself: the image is added, the field keeps its text
field = q('[data-testid="media-pending-name"]');
typeInto(window, field, 'first.jpg');
const ev = paste(field, { files: [file('again.png', 'image/png')] });
await waitFor(() => qa('[data-testid="media-pending-row"]').length === 2);
check('an image pasted into a name field is added as another row, the field keeps its text, the event is consumed', qa('[data-testid="media-pending-row"]').length === 2 && qa('[data-testid="media-pending-name"]')[0].value === 'first.jpg' && ev.defaultPrevented);
click(window, q('[data-testid="media-upload-cancel"]'));
await waitFor(() => !q('[data-testid="media-pending-row"]'));
check('Cancel discards both', !q('[data-testid="media-pending-row"]') && (await names()).length === 3);

// ---- a text paste is not ours ----
click(window, q('[data-testid="media-tab-browse"]'));
await waitFor(() => q('input[placeholder^="Search"]'));
const search = q('input[placeholder^="Search"]');
search.focus();
const textEv = paste(search, { text: 'hello' });
await sleep(30);
check('a text paste into the search field is left alone (not consumed, nothing pending, the Upload tab not switched)', !textEv.defaultPrevented && !q('[data-testid="media-pending-row"]') && q('[data-testid="media-tab-browse"]'));
click(window, q('[data-testid="media-tab-upload"]'));
await waitFor(() => q('[data-testid="media-upload-drop"]'));
const textEv2 = paste(document.body, { text: 'plain text' });
await sleep(30);
check('a text paste on the Upload tab adds nothing and is not consumed', !textEv2.defaultPrevented && !q('[data-testid="media-pending-row"]'));

// ---- two rows with the same name ----
dropFile(window, q('[data-testid="media-upload-drop"]'), file('a.png'));
await waitFor(() => q('[data-testid="media-pending-name"]'));
paste(document.body, { files: [file('b.png')] });
await waitFor(() => qa('[data-testid="media-pending-name"]').length === 2);
typeInto(window, qa('[data-testid="media-pending-name"]')[0], 'same.png');
typeInto(window, qa('[data-testid="media-pending-name"]')[1], 'same.png');
await sleep(20);
check('the second of two rows with the same name shows same-2.png', /same-2\.png/.test(qa('[data-testid="media-pending-row"]')[1].textContent));
click(window, q('[data-testid="media-upload-confirm"]'));
await waitFor(async () => (await names()).length === 5);
check('both are stored, the second as same-2.png', (await names()).includes('same.png') && (await names()).includes('same-2.png'), (await names()).join(','));

// ---- Browse lists them ----
click(window, q('[data-testid="media-tab-browse"]'));
await waitFor(() => /same-2\.png/.test(document.body.textContent));
check('the Browse tab lists the stored names', /diagram\.png/.test(document.body.textContent) && /same-2\.png/.test(document.body.textContent) && new RegExp(pastedName.replace('.', '\\.')).test(document.body.textContent));

mod.unmountModal();
summary();
