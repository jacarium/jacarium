/**
 * The Media Library's image names (src/utils/mediaNames.js), and the store
 * that applies them (src/utils/media.js uploadMedia, over fake-indexeddb):
 *
 *   - sanitising: whitespace and link-breaking characters become `_`, path
 *     separators, `..`, control characters, an empty name and a bare
 *     extension are refused, the length is capped with the
 *     extension kept, the extension follows the image's actual type (a PNG
 *     called `x.jpg` is stored as `x.png`, `x` as `x.png`, `x.txt` as
 *     `x.txt.png`), a non-image type is refused;
 *   - uniqueness: `name-2.png`, `name-3.png`, ... like the JSON importer;
 *   - the screenshot name for a pasted image: `screenshot-YYYY-MM-DD-HHMMSS.png`
 *     in local time;
 *   - the clipboard reader takes image files (and image items) and ignores
 *     a text paste;
 *   - uploadMedia stores under the sanitised, unique name, honours a
 *     requested name, keeps its old whitespace-to-underscore behaviour, and
 *     refuses a non-image; the JSON importer's stored names go through the
 *     same sanitiser.
 *
 * Run:  node tests/media-names.test.mjs   (needs jsdom + fake-indexeddb:
 *                                         npm install --no-save jsdom fake-indexeddb)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { mod, window } = await setupDocumentsEnv('media-names', { entry: path.join(here, 'helpers', 'media-library-entry.mjs') });
const { check, summary } = makeChecker();
const { sanitizeMediaName, uniqueMediaName, screenshotName, clipboardImageFiles, MEDIA_NAME_MAX, imageExtensions } = mod.mediaNames;
const { uploadMedia, getAllMedia } = mod.media;
const { db } = mod;

// ---- sanitising ----
const ok = (requested, type, expected) => { const r = sanitizeMediaName(requested, type); check(`sanitize(${JSON.stringify(requested)}, ${type}) -> ${expected}`, r.name === expected && !r.error, JSON.stringify(r)); };
const bad = (requested, type, why) => { const r = sanitizeMediaName(requested, type); check(`sanitize(${JSON.stringify(requested)}, ${type}) is refused (${why})`, !!r.error && !r.name, JSON.stringify(r)); };
ok('photo.png', 'image/png', 'photo.png');
ok('  my photo (1).png ', 'image/png', 'my_photo_1_.png');
ok('shot.JPG', 'image/jpeg', 'shot.jpg');
ok('diagram.jpg', 'image/png', 'diagram.png');
ok('diagram', 'image/png', 'diagram.png');
ok('notes.txt', 'image/png', 'notes.txt.png');
ok('a)b[c]d?e#f\'g"h.webp', 'image/webp', 'a_b_c_d_e_f_g_h.webp');
ok('tab\there.gif', 'image/gif', 'tab_here.gif');
ok('x.svg', 'image/svg+xml', 'x.svg');
ok('x.tiff', 'image/tiff', 'x.tiff');
ok('a; b=c.png', 'image/png; charset=binary', 'a;_b=c.png');
bad('', 'image/png', 'empty');
bad('   ', 'image/png', 'blank');
bad('.png', 'image/png', 'no base');
bad('C:\\fakepath\\shot.png', 'image/png', 'a path');
bad('/tmp/dir/shot.jpeg', 'image/jpeg', 'a path');
bad('dir/shot.png', 'image/png', 'a path');
bad('../../etc/passwd.png', 'image/png', '..');
bad('a..b.png', 'image/png', '.. inside');
bad('bad\u0000name.png', 'image/png', 'NUL');
bad('bad\u001bname.png', 'image/png', 'escape');
bad('x.png', 'text/plain', 'not an image');
bad('x.png', '', 'no type');
bad('x.png', 'application/octet-stream', 'octet-stream');
{
  const long = 'a'.repeat(300) + '.png';
  const r = sanitizeMediaName(long, 'image/png');
  check(`a 304-character name is cut to ${MEDIA_NAME_MAX} with its extension kept`, r.name.length === MEDIA_NAME_MAX && r.name.endsWith('.png'), r.name && r.name.length);
}
check('imageExtensions knows the accepted types and nothing else', JSON.stringify(imageExtensions('image/jpeg')) === '["jpg","jpeg"]' && imageExtensions('image/x-icon') === null && imageExtensions('text/html') === null);

// ---- uniqueness ----
check('a free name stays', uniqueMediaName('a.png', ['b.png']) === 'a.png');
check('a taken name gets -2', uniqueMediaName('a.png', ['a.png']) === 'a-2.png');
check('-2 taken too: -3', uniqueMediaName('a.png', ['a.png', 'a-2.png']) === 'a-3.png');
check('the first free number wins (-2 free while -3 is taken)', uniqueMediaName('a.png', ['a.png', 'a-3.png']) === 'a-2.png');
check('a name without extension', uniqueMediaName('a', ['a']) === 'a-2');

// ---- the screenshot name ----
check('screenshotName is local time, zero-padded, with the type\'s extension', screenshotName(new Date(2026, 9, 29, 7, 5, 9), 'image/png') === 'screenshot-2026-10-29-070509.png' && screenshotName(new Date(2026, 0, 1, 23, 59, 59), 'image/jpeg') === 'screenshot-2026-01-01-235959.jpg');
check('screenshotName defaults to png for an unknown type', screenshotName(new Date(2026, 9, 29, 7, 5, 9), 'application/x-unknown').endsWith('.png'));

// ---- the clipboard reader ----
const png = new window.File([new Uint8Array([137, 80, 78, 71])], 'clip.png', { type: 'image/png' });
const txt = new window.File([new Uint8Array([65])], 'note.txt', { type: 'text/plain' });
check('image files among clipboardData.files are taken, text files are not', clipboardImageFiles({ files: [txt, png], items: [] }).length === 1 && clipboardImageFiles({ files: [txt, png] })[0] === png);
check('image items are read with getAsFile when there are no files', clipboardImageFiles({ files: [], items: [{ kind: 'string', type: 'text/plain' }, { kind: 'file', type: 'image/png', getAsFile: () => png }] })[0] === png);
check('a text paste yields nothing', clipboardImageFiles({ files: [], items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] }).length === 0 && clipboardImageFiles(null).length === 0);

// ---- the store ----
await db.media.clear();
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const file = (name, type = 'image/png') => new window.File([bytes], name, { type });
let refused = null;
let rec = await uploadMedia(file('my shot.png'));
check('uploadMedia keeps the whitespace-to-underscore behaviour', rec.filename === 'my_shot.png', rec.filename);
rec = await uploadMedia(file('my shot.png'));
check('the same name again is stored as my_shot-2.png', rec.filename === 'my_shot-2.png', rec.filename);
rec = await uploadMedia(file('whatever.png'), { name: 'renamed (final).png' });
check('a requested name is sanitised and used', rec.filename === 'renamed_final_.png', rec.filename);
rec = await uploadMedia(file('photo.jpg'), { name: 'photo.jpg' });
check('a requested extension that does not match the type is corrected', rec.filename === 'photo.png', rec.filename);
refused = null;
try { await uploadMedia(file('C:\\fakepath\\deep.png')); } catch (e) { refused = e.message; }
check('a path is refused by the store itself', /cannot contain/.test(refused || ''), refused);
try { await uploadMedia(file('x.txt', 'text/plain')); } catch (e) { refused = e.message; }
check('a non-image is refused by the store itself', /not an image/i.test(refused || ''), refused);
refused = null;
try { await uploadMedia(file('x.png'), { name: '../x.png' }); } catch (e) { refused = e.message; }
check("a name with '..' (here also a path) is refused by the store itself", /\.\.|cannot contain/.test(refused || ''), refused);
const names = (await getAllMedia()).map((m) => m.filename).sort();
check('the library holds exactly the four accepted names', JSON.stringify(names) === JSON.stringify(['my_shot-2.png', 'my_shot.png', 'photo.png', 'renamed_final_.png']), names.join(','));

// ---- the JSON importer stores through the same sanitiser ----
{
  const { importDocumentMedia, newImportSession } = mod.documentAttachments;
  const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  const doc = { title: 'T', content: '![a](attachment:evil#one.png) and ![b](attachment:ok.png)', media: [{ filename: 'evil#one.png', mimeType: 'image/png', size: bytes.length, data: dataUrl, uploadedAt: '2026-01-02T03:04:05.000Z', tags: [] }, { filename: 'ok.png', mimeType: 'image/png', size: bytes.length, data: dataUrl, uploadedAt: '2026-01-02T03:04:05.000Z', tags: [] }] };
  const result = await importDocumentMedia(doc, newImportSession());
  const stored = (await getAllMedia()).map((m) => m.filename);
  check('an imported image with a link-breaking name is stored under the sanitised name and the reference rewritten', stored.includes('evil_one.png') && !stored.includes('evil#one.png') && result.content.includes('attachment:evil_one.png') && !result.content.includes('attachment:evil#one.png') && result.renamed.some(([a, b]) => a === 'evil#one.png' && b === 'evil_one.png'), `${stored.join(',')} | ${result.content}`);
  check('a clean imported name is stored as it is', stored.includes('ok.png') && result.content.includes('attachment:ok.png'));
}

summary();
