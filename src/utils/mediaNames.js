/**
 * Names of images in the Media Library (src/utils/media.js stores them in
 * IndexedDB; documents reference them as `attachment:<filename>`), decided
 * in one place and applied at the store itself, so every way an image
 * arrives - the Upload tab's file picker, a drop, a paste, a JSON import -
 * goes through the same rules:
 *
 *   - a name is trimmed and never empty, and never only an extension;
 *   - no path separators, no `..`, no control characters (names never reach
 *     a file system here, but exports and future servers must not have to
 *     care, and a name is a name, not a location);
 *   - whitespace (tabs and line breaks included) and the characters that
 *     would end a markdown link destination early (`( ) [ ] ? # ' " < > \` |`)
 *     become `_`, as uploadMedia always did for whitespace;
 *   - at most MEDIA_NAME_MAX characters, the extension kept;
 *   - the extension matches the image's actual type (a PNG called `x.jpg`
 *     becomes `x.png`, a PNG called `x` becomes `x.png`); a type that is not
 *     an image is refused;
 *   - a name already in the library gets `-2`, `-3`, ... before the
 *     extension (the convention the JSON importer uses for collisions).
 *
 * Pure: no DOM, no database, so the same module serves the tests and any
 * server that may handle image names one day.
 */

export const MEDIA_NAME_MAX = 120;

// the image types the library accepts (what the Upload tab lists, plus the
// formats browsers paste and the import file may carry) and their extensions
const EXTENSIONS = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/svg+xml': ['svg'],
  'image/bmp': ['bmp'],
  'image/avif': ['avif'],
  'image/tiff': ['tif', 'tiff'],
};
const ALL_EXTENSIONS = new Set(Object.values(EXTENSIONS).flat());

/** The extensions an image MIME type may carry, or null when the type is not an image the library accepts. */
export function imageExtensions(mimeType) {
  return EXTENSIONS[String(mimeType || '').toLowerCase().split(';')[0].trim()] || null;
}

/** [base, extension without the dot, or ''] of a file name. */
export function splitExtension(name) {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return [name, ''];
  return [name.slice(0, idx), name.slice(idx + 1).toLowerCase()];
}

/**
 * The name an image is stored under for a requested name and its MIME type:
 * { name } when it is acceptable (possibly changed as described above), or
 * { error } with a sentence for the user when nothing acceptable can be made.
 */
export function sanitizeMediaName(requested, mimeType) {
  const extensions = imageExtensions(mimeType);
  if (!extensions) return { error: 'Not an image file.' };
  let name = String(requested ?? '').trim();
  if (!name) return { error: 'A name is required.' };
  if (/[\\/]/.test(name)) return { error: 'A name cannot contain / or \\.' };
  if (name.includes('..')) return { error: "'..' is not allowed in a name." };
  // whitespace (tabs and line breaks included) and the link-breaking characters, each run to one underscore
  name = name.replace(/[\s()[\]?#'"<>`|]+/g, '_').replace(/^_+|_+$/g, '');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(name)) return { error: 'Control characters are not allowed in a name.' };
  if (!name || /^\.[^.]*$/.test(name)) return { error: 'A name is required.' };   // empty, or only an extension
  let [base, ext] = splitExtension(name);
  if (!base.replace(/[._]+/g, '')) return { error: 'A name is required.' };
  if (!extensions.includes(ext)) {
    // a wrong image extension is replaced, any other suffix is kept as part of the base
    if (!ALL_EXTENSIONS.has(ext)) base = ext ? `${base}.${ext}` : base;
    ext = extensions[0];
  }
  base = base.replace(/\.+$/g, '') || 'image';
  const room = MEDIA_NAME_MAX - ext.length - 1;
  if (base.length > room) base = base.slice(0, room);
  return { name: `${base}.${ext}` };
}

/**
 * `name` unless the library already has it: then `name-2.ext`, `name-3.ext`,
 * ... (the first free one). `taken` is any iterable of existing names.
 */
export function uniqueMediaName(name, taken) {
  const have = new Set(taken);
  if (!have.has(name)) return name;
  const [base, ext] = splitExtension(name);
  const suffix = ext ? `.${ext}` : '';
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}${suffix}`;
    if (!have.has(candidate)) return candidate;
  }
}

/** `screenshot-YYYY-MM-DD-HHMMSS.<ext>` in local time, for an image pasted from the clipboard (which has no name). */
export function screenshotName(date = new Date(), mimeType = 'image/png') {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ext = (imageExtensions(mimeType) || ['png'])[0];
  return `screenshot-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.${ext}`;
}

/** The image files among a paste's clipboardData (its files, else its image items), oldest-first; [] for a text paste. */
export function clipboardImageFiles(clipboardData) {
  if (!clipboardData) return [];
  const files = Array.from(clipboardData.files || []).filter((f) => f && typeof f.type === 'string' && f.type.startsWith('image/'));
  if (files.length) return files;
  return Array.from(clipboardData.items || [])
    .filter((item) => item && item.kind === 'file' && typeof item.type === 'string' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
}
