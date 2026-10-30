/**
 * "Replace Image" in the Media Library, in jsdom over fake-indexeddb with
 * the REAL modal, store and exports (tests/helpers/media-library-entry.mjs):
 *
 *   - the type helpers: sameImageType (JPEG and JPG are one type),
 *     sniffImageType (the signatures), imageTypeLabel;
 *   - the store: replaceMedia keeps the id, the name, the tags, the upload
 *     date and the sync identity, swaps the blob, the type and the size and
 *     sets updatedAt; the sync tables read updatedAt as the record's time
 *     and the tracker marks the row dirty, so it travels as an edit; a file
 *     of another type is refused by its declared type and by its bytes
 *     (a "PNG" holding JPEG data), a non-image and a missing record too,
 *     and nothing is stored on a refusal;
 *   - the modal: the ... menu's Replace Image opens the Upload tab in
 *     replace mode (the banner, the narrowed picker, the hint naming the
 *     type); a paste, a drop and the picker each give ONE pending row with
 *     the name read-only; Replace asks "Replace <name>? Documents using it
 *     will show the new image." and the Browse tab then lists the same name
 *     with the new bytes behind it; a second file (picker, paste - the drop
 *     zone is gone while the row is pending) is refused with a message
 *     (several at once: the first is taken); Cancel on the row and on the
 *     banner leave the image untouched; a different type through the
 *     picker, a drop and a paste is refused inline with Replace disabled
 *     (Enter does nothing); a JPEG record takes .jpg and .jpeg alike;
 *   - the ZIP / Markdown exports after a replace carry the image under the
 *     same name with the new content.
 *
 * Run:  node tests/media-replace-image.test.mjs   (needs jsdom + fake-indexeddb)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { setupDocumentsEnv, makeChecker, click, waitFor, chooseFile, dropFile, sleep } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { mod, window, downloads } = await setupDocumentsEnv('media-replace-image', { entry: path.join(here, 'helpers', 'media-library-entry.mjs') });
const { check, summary } = makeChecker();
const { document } = window;
const { uploadMedia, getAllMedia, getMediaByFilename, replaceMedia, replaceRefusal, updateMediaTags } = mod.media;
const { sameImageType, sniffImageType, imageTypeLabel } = mod.mediaNames;
const { db, SYNC_TABLES } = mod;

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const png = (...tail) => new Uint8Array([...PNG_SIG, ...tail]);
const jpeg = (...tail) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...tail]);
const PNG_A = png(1, 1, 1);
const PNG_B = png(2, 2, 2, 2, 2);
const PNG_C = png(3, 3, 3, 3, 3, 3, 3);
const PNG_D = png(4, 4);
const PNG_Z = png(9, 9, 9, 9, 9, 9, 9, 9, 9);
const JPEG_A = jpeg(1);
const JPEG_B = jpeg(2, 2);
// Node's own Blob with a name: fake-indexeddb's structured clone keeps it a Blob (a jsdom File, and even a
// Node File, come back as bare objects), as tests/documents-export-images.test.mjs stores its images
const file = (name, type, bytes) => { const b = new Blob([bytes], { type }); Object.defineProperty(b, 'name', { value: name, enumerable: true }); return b; };
const bytesOf = async (blob) => Array.from(new Uint8Array(await blob.arrayBuffer()));
const same = (a, b) => JSON.stringify(Array.from(a)) === JSON.stringify(Array.from(b));
const storedBytes = async (name) => bytesOf((await getMediaByFilename(name)).blob);
const q = (sel) => document.querySelector(sel);
const qa = (sel) => Array.from(document.querySelectorAll(sel));
const key = (el, k) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const paste = (target, files) => {
  const ev = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { files, items: [], types: ['Files'], getData: () => '' } });
  target.dispatchEvent(ev);
  return ev;
};
const dropFiles = (el, files) => {
  const ev = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files, items: [], types: ['Files'] } });
  el.dispatchEvent(ev);
};

/* ---------- the type helpers ---------- */
check('image/jpeg and image/jpg are one type', sameImageType('image/jpeg', 'image/jpg') && sameImageType('image/jpg', 'image/jpeg') && sameImageType('image/png', 'image/png'));
check('PNG and JPEG are not; an unknown type matches nothing', !sameImageType('image/png', 'image/jpeg') && !sameImageType('', '') && !sameImageType('text/plain', 'text/plain'));
check('the signatures are read: PNG, JPEG, GIF, WebP, SVG; other bytes give null',
  sniffImageType(PNG_A) === 'image/png' && sniffImageType(JPEG_A) === 'image/jpeg'
  && sniffImageType(new TextEncoder().encode('GIF89a....')) === 'image/gif'
  && sniffImageType(new Uint8Array([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8 ')])) === 'image/webp'
  && sniffImageType(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')) === 'image/svg+xml'
  && sniffImageType(new TextEncoder().encode('hello there')) === null && sniffImageType(new Uint8Array()) === null);
check('the labels', imageTypeLabel('image/png') === 'PNG' && imageTypeLabel('image/jpeg; charset=x') === 'JPEG' && imageTypeLabel('image/webp') === 'WebP' && imageTypeLabel('application/pdf') === '');

/* ---------- the store ---------- */
await db.media.clear();
const first = await uploadMedia(file('pic.png', 'image/png', PNG_A), { name: 'pic.png' });
await updateMediaTags(first.id, ['diagrams', 'cluster']);
const before = await getMediaByFilename('pic.png');
check('(setup) pic.png is stored with its tags', before && before.mimeType === 'image/png' && before.tags.join(',') === 'diagrams,cluster' && typeof before.syncId === 'string');
await db._syncState.where('collection').equals('media').modify({ dirty: 0 });
await sleep(5);
const after = await replaceMedia(first.id, file('whatever-new-name.png', 'image/png', PNG_B));
const stored = await getMediaByFilename('pic.png');
check('replaceMedia keeps the id, the name, the tags, the upload date and the sync identity',
  after.id === first.id && stored.id === first.id && stored.filename === 'pic.png' && stored.tags.join(',') === 'diagrams,cluster' && stored.uploadedAt === before.uploadedAt && stored.syncId === before.syncId,
  JSON.stringify({ id: stored.id, name: stored.filename, tags: stored.tags, syncId: stored.syncId === before.syncId }));
check('...and swaps the blob, the type and the size, and sets updatedAt', same(await bytesOf(stored.blob), PNG_B) && stored.mimeType === 'image/png' && stored.size === PNG_B.length && typeof stored.updatedAt === 'string' && stored.updatedAt > before.uploadedAt && after.size === PNG_B.length, `${stored.size} ${stored.updatedAt}`);
check('the library still holds one image', (await getAllMedia()).length === 1);
check('the sync tables take updatedAt as the record\'s time (an edit, not a re-upload)', SYNC_TABLES.media.timestamp(stored) === stored.updatedAt && SYNC_TABLES.media.timestamp(before) === before.uploadedAt);
const state = await db._syncState.get(['media', stored.syncId]);
check('the sync tracker marked the replaced row dirty, so it is pushed as an edit of the same record', state?.dirty === 1, JSON.stringify(state));

const refusals = [];
for (const [label, f] of [['a JPEG', file('x.jpg', 'image/jpeg', JPEG_A)], ['a "PNG" holding JPEG bytes', file('x.png', 'image/png', JPEG_A)], ['a text file', file('x.txt', 'text/plain', new TextEncoder().encode('hi'))]]) {
  try { await replaceMedia(first.id, f); refusals.push(`${label}: accepted`); } catch (e) { refusals.push(`${label}: ${e.message}`); }
}
check('a JPEG is refused for a PNG, by its declared type', refusals[0] === 'a JPEG: Replace with a PNG image (the current image is a PNG).', refusals[0]);
check('a file declared PNG whose bytes are JPEG is refused, by its content', /^a "PNG" holding JPEG bytes: Replace with a PNG image \(the current image is a PNG; this file's content is JPEG\)\.$/.test(refusals[1]), refusals[1]);
check('a non-image is refused', refusals[2] === 'a text file: Replace with a PNG image (the current image is a PNG).', refusals[2]);
check('nothing was stored on the refusals', same(await storedBytes('pic.png'), PNG_B) && (await getAllMedia()).length === 1);
let missing = '';
try { await replaceMedia(99999, file('x.png', 'image/png', PNG_A)); } catch (e) { missing = e.message; }
check('a missing record is refused', /no longer in the library/.test(missing), missing);
check('replaceRefusal without the bytes judges the declared type only', replaceRefusal(stored, file('x.png', 'image/png', JPEG_A), null) === null && replaceRefusal(stored, file('x.jpg', 'image/jpeg', JPEG_A), null) !== null);

const shot = await uploadMedia(file('shot.jpg', 'image/jpeg', JPEG_A), { name: 'shot.jpg' });
await replaceMedia(shot.id, file('other.jpeg', 'image/jpeg', JPEG_B));
check('a JPEG record takes a .jpeg file of type image/jpeg', same(await storedBytes('shot.jpg'), JPEG_B));
await replaceMedia(shot.id, file('other.jpg', 'image/jpg', JPEG_A));
check('...and image/jpg (the same type) alike, under the same name', same(await storedBytes('shot.jpg'), JPEG_A) && (await getMediaByFilename('shot.jpg')).filename === 'shot.jpg');
let pngForJpeg = '';
try { await replaceMedia(shot.id, file('x.png', 'image/png', PNG_A)); } catch (e) { pngForJpeg = e.message; }
check('a PNG is refused for a JPEG', pngForJpeg === 'Replace with a JPEG image (the current image is a JPEG).', pngForJpeg);

/* ---------- the modal ---------- */
const openBrowse = async () => {
  mod.renderModal();
  await waitFor(() => q('[data-testid="media-tab-browse"]'));
  click(window, q('[data-testid="media-tab-browse"]'));
  await waitFor(() => qa('button[title="Actions"]').length > 0);
};
const cardOf = (name) => qa('img[alt]').find((img) => img.getAttribute('alt') === name)?.closest('.group');
const startReplace = async (name) => {
  await openBrowse();
  const card = cardOf(name);
  click(window, card.querySelector('button[title="Actions"]'));
  await waitFor(() => q('[data-testid="media-menu-replace"]'));
  click(window, q('[data-testid="media-menu-replace"]'));
  await waitFor(() => q('[data-testid="media-replace-banner"]'));
};
const confirmButton = () => qa('button').find((b) => b.textContent.trim() === 'Replace' && b.className.includes('btn-brand'));
const pendingRows = () => qa('[data-testid="media-pending-row"]');
const rowError = () => q('[data-testid="media-pending"]')?.textContent || '';

await startReplace('pic.png');
check('Replace Image opens the Upload tab in replace mode: the banner names the image, with its thumbnail and a Cancel', q('[data-testid="media-tab-upload"]').getAttribute('aria-selected') !== 'false' && /Replacing pic\.png/.test(q('[data-testid="media-replace-banner"]').textContent) && !!q('[data-testid="media-replace-banner"] img') && !!q('[data-testid="media-replace-cancel"]'));
check('the drop zone says what it takes and the picker is narrowed to one file of that type', /Replace Image/.test(q('[data-testid="media-upload-drop"]').textContent) && /Drag and drop a PNG image here/.test(q('[data-testid="media-upload-drop"]').textContent) && q('[data-testid="media-upload-hint"]').textContent === 'Accepts: PNG only (the current image is a PNG)' && q('[data-testid="media-upload-input"]').getAttribute('accept') === 'image/png,.png' && !q('[data-testid="media-upload-input"]').multiple, q('[data-testid="media-upload-input"]').getAttribute('accept'));

// paste -> confirm -> the Browse tab shows the same name with the new image
paste(document.body, [file('clip.png', 'image/png', PNG_C)]);
await waitFor(() => pendingRows().length === 1);
const nameField = q('[data-testid="media-pending-name"]');
check('a pasted PNG becomes the single pending row, its name the replaced image\'s and read-only', nameField.value === 'pic.png' && nameField.readOnly && /Replace with this image/.test(q('[data-testid="media-pending"]').textContent) && /Keeps this name/.test(rowError()));
check('the confirm button reads Replace and is enabled', q('[data-testid="media-upload-confirm"]').textContent === 'Replace' && !q('[data-testid="media-upload-confirm"]').disabled);
click(window, q('[data-testid="media-upload-confirm"]'));
await waitFor(() => /Replace pic\.png\?/.test(document.body.textContent));
check('Replace asks first', /Replace pic\.png\? Documents using it will show the new image\./.test(document.body.textContent) && !!confirmButton());
check('nothing is stored before the confirmation', same(await storedBytes('pic.png'), PNG_B));
click(window, confirmButton());
await waitFor(async () => same(await storedBytes('pic.png'), PNG_C));
await waitFor(() => qa('button[title="Actions"]').length > 0);
check('after the confirmation the image is replaced under the same name and the Browse tab lists it', same(await storedBytes('pic.png'), PNG_C) && !!cardOf('pic.png') && (await getAllMedia()).length === 2 && !q('[data-testid="media-replace-banner"]'));
check('(the tags survived the UI path)', (await getMediaByFilename('pic.png')).tags.join(',') === 'diagrams,cluster');

// drop
await startReplace('pic.png');
dropFile(window, q('[data-testid="media-upload-drop"]'), file('dropped.png', 'image/png', PNG_D));
await waitFor(() => pendingRows().length === 1);
check('a dropped PNG becomes the pending row', q('[data-testid="media-pending-name"]').value === 'pic.png');
key(q('[data-testid="media-pending-name"]'), 'Enter');
await waitFor(() => /Replace pic\.png\?/.test(document.body.textContent));
click(window, confirmButton());
await waitFor(async () => same(await storedBytes('pic.png'), PNG_D));
check('Enter in the name field asks, and the confirmation replaces (drop path)', same(await storedBytes('pic.png'), PNG_D));

// the picker
await startReplace('pic.png');
chooseFile(window, q('[data-testid="media-upload-input"]'), file('picked.png', 'image/png', PNG_A));
await waitFor(() => pendingRows().length === 1);
click(window, q('[data-testid="media-upload-confirm"]'));
await waitFor(() => /Replace pic\.png\?/.test(document.body.textContent));
click(window, confirmButton());
await waitFor(async () => same(await storedBytes('pic.png'), PNG_A));
check('Browse Files path: replaced', same(await storedBytes('pic.png'), PNG_A));

// one file only
await startReplace('pic.png');
dropFile(window, q('[data-testid="media-upload-drop"]'), file('one.png', 'image/png', PNG_B));
await waitFor(() => pendingRows().length === 1);
check('with the row pending the drop zone is gone (one image is all a replace takes); the picker and a paste remain', !q('[data-testid="media-upload-drop"]') && !!q('[data-testid="media-upload-input"]'));
chooseFile(window, q('[data-testid="media-upload-input"]'), file('two.png', 'image/png', PNG_C));
paste(document.body, [file('three.png', 'image/png', PNG_D)]);
await sleep(40);
check('a second file while one is pending is refused: still one row, the first', pendingRows().length === 1 && /one\.png/.test(pendingRows()[0].textContent), pendingRows()[0]?.textContent);
click(window, q('[data-testid="media-upload-cancel"]'));
await waitFor(() => pendingRows().length === 0);
check('Cancel on the row drops it and stays in replace mode, the image untouched', !!q('[data-testid="media-replace-banner"]') && same(await storedBytes('pic.png'), PNG_A));
dropFiles(q('[data-testid="media-upload-drop"]'), [file('first.png', 'image/png', PNG_B), file('second.png', 'image/png', PNG_C)]);
await waitFor(() => pendingRows().length === 1);
check('several files at once: the first is taken, the rest ignored', pendingRows().length === 1 && /first\.png/.test(pendingRows()[0].textContent));
check('the banner\'s button says "Exit replace" (the footer\'s Cancel drops the picked image)', q('[data-testid="media-replace-cancel"]').textContent.trim() === 'Exit replace');
click(window, q('[data-testid="media-replace-cancel"]'));
await waitFor(() => !q('[data-testid="media-replace-banner"]'));
check('Cancel on the banner leaves replace mode: no rows, the plain Upload tab back, the image untouched', pendingRows().length === 0 && /Upload Images/.test(q('[data-testid="media-upload-drop"]').textContent) && q('[data-testid="media-upload-input"]').getAttribute('accept') === 'image/*' && q('[data-testid="media-upload-input"]').multiple && same(await storedBytes('pic.png'), PNG_A));

// a different type is refused inline, through each way in
const REFUSAL = 'Replace with a PNG image (the current image is a PNG).';
await startReplace('pic.png');
chooseFile(window, q('[data-testid="media-upload-input"]'), file('x.jpg', 'image/jpeg', JPEG_A));
await waitFor(() => pendingRows().length === 1);
check('a JPEG through the picker: the row shows the refusal and Replace is disabled', rowError().includes(REFUSAL) && q('[data-testid="media-upload-confirm"]').disabled, rowError());
key(q('[data-testid="media-pending-name"]'), 'Enter');
await sleep(30);
check('Enter does not ask', !/Replace pic\.png\?/.test(document.body.textContent));
click(window, q('[data-testid="media-upload-cancel"]'));
await waitFor(() => pendingRows().length === 0);
dropFile(window, q('[data-testid="media-upload-drop"]'), file('x.jpg', 'image/jpeg', JPEG_A));
await waitFor(() => pendingRows().length === 1);
check('a JPEG dropped: refused inline', rowError().includes(REFUSAL) && q('[data-testid="media-upload-confirm"]').disabled);
click(window, q('[data-testid="media-upload-cancel"]'));
await waitFor(() => pendingRows().length === 0);
paste(document.body, [file('x.jpg', 'image/jpeg', JPEG_A)]);
await waitFor(() => pendingRows().length === 1);
check('a JPEG pasted: refused inline', rowError().includes(REFUSAL) && q('[data-testid="media-upload-confirm"]').disabled);
click(window, q('[data-testid="media-upload-cancel"]'));
await waitFor(() => pendingRows().length === 0);
dropFile(window, q('[data-testid="media-upload-drop"]'), file('fake.png', 'image/png', JPEG_A));
await waitFor(() => pendingRows().length === 1 && /content is JPEG/.test(rowError()));
check('a "PNG" holding JPEG bytes: refused once the bytes are read, Replace disabled', /Replace with a PNG image \(the current image is a PNG; this file's content is JPEG\)\./.test(rowError()) && q('[data-testid="media-upload-confirm"]').disabled, rowError());
click(window, q('[data-testid="media-replace-cancel"]'));
await waitFor(() => !q('[data-testid="media-replace-banner"]'));
check('nothing was stored through the refused files', same(await storedBytes('pic.png'), PNG_A) && (await getAllMedia()).length === 2);

// JPEG / JPG alike in the modal
await startReplace('shot.jpg');
check('a JPEG record narrows the picker to JPEG with both extensions and says so', q('[data-testid="media-upload-input"]').getAttribute('accept') === 'image/jpeg,.jpg,.jpeg' && q('[data-testid="media-upload-hint"]').textContent === 'Accepts: JPEG only (the current image is a JPEG)', q('[data-testid="media-upload-input"]').getAttribute('accept'));
paste(document.body, [file('photo.jpeg', 'image/jpeg', JPEG_B)]);
await waitFor(() => pendingRows().length === 1);
check('a .jpeg for a .jpg is taken', !q('[data-testid="media-upload-confirm"]').disabled && q('[data-testid="media-pending-name"]').value === 'shot.jpg');
click(window, q('[data-testid="media-upload-confirm"]'));
await waitFor(() => /Replace shot\.jpg\?/.test(document.body.textContent));
click(window, confirmButton());
await waitFor(async () => same(await storedBytes('shot.jpg'), JPEG_B));
check('...and replaces shot.jpg in place', same(await storedBytes('shot.jpg'), JPEG_B) && (await getAllMedia()).map((m) => m.filename).sort().join(',') === 'pic.png,shot.jpg');
mod.unmountModal();

/* ---------- the exports after a replace ---------- */
const { createDocument, getDocuments } = mod.documents;
await createDocument({ title: 'Cluster notes', category: 'General', content: 'Before\n\n![pic](attachment:pic.png)\n\nAfter' });
const docs = await getDocuments();
const doc = docs.find((d) => d.title === 'Cluster notes');
await replaceMedia((await getMediaByFilename('pic.png')).id, file('final.png', 'image/png', PNG_Z));
const { exportAllToZip, exportDocumentToZip } = mod.getImportExport();
const readZip = async (index) => {
  const dl = downloads[index];
  const zip = await JSZip.loadAsync(Buffer.from(await dl.blob.arrayBuffer()));
  const names = Object.keys(zip.files);
  const imageEntry = names.find((n) => n.endsWith('images/pic.png'));
  const mdEntry = names.find((n) => n.endsWith('.md'));
  return { names, image: imageEntry ? Array.from(await zip.file(imageEntry).async('uint8array')) : null, md: mdEntry ? await zip.file(mdEntry).async('string') : '' };
};
let n = downloads.length;
await exportAllToZip(docs, 'documents');
await waitFor(() => downloads.length > n);
let z = await readZip(n);
check('Export All (ZIP): the image is there under its name, with the NEW bytes, and the Markdown points at it', z.image !== null && same(z.image, PNG_Z) && /!\[pic\]\(images\/pic\.png\)/.test(z.md), z.names.join(','));
n = downloads.length;
await exportDocumentToZip(doc);
await waitFor(() => downloads.length > n);
z = await readZip(n);
check('the single-document ZIP too', z.image !== null && same(z.image, PNG_Z) && /images\/pic\.png/.test(z.md), z.names.join(','));

summary();
