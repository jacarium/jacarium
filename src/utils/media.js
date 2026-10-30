import { db } from '../db/database';
import { sanitizeMediaName, uniqueMediaName, sameImageType, sniffImageType, imageTypeLabel } from './mediaNames';

/**
 * Media Management Utilities
 * Handles image uploads, storage, and retrieval for documents
 * Uses Blob storage instead of base64 for better performance and smaller size
 */

// Cache of object URLs keyed by media id. Object URLs are just references to
// the stored Blob (no base64 encoding/decoding, no duplicated string memory),
// so thumbnails render without reading every blob through a FileReader.
// Entries are revoked when the underlying media record is deleted.
const objectUrlCache = new Map();

function getObjectUrl(record) {
  let url = objectUrlCache.get(record.id);
  if (!url) {
    url = URL.createObjectURL(record.blob);
    objectUrlCache.set(record.id, url);
  }
  return url;
}

/**
 * Upload a media file: stored under the name the rules of mediaNames.js
 * make of `name` (the file's own name when none is given) - whitespace and
 * link-breaking characters to `_`, the extension of the image's actual
 * type, `-2` / `-3` when the library already has the name - so every way
 * in (the picker, a drop, a paste, an import) ends up with the same kind
 * of name. Refuses a file that is not an image or a name that cannot be
 * made acceptable (the error's message is for the user).
 * @param {File} file - The file to upload
 * @param {{ name?: string }} [options] - the name to store it under
 * @returns {Promise<Object>} The created media record
 */
export async function uploadMedia(file, { name } = {}) {
  const clean = sanitizeMediaName(name ?? file.name, file.type);
  if (clean.error) throw new Error(clean.error);
  const taken = await db.media.orderBy('filename').uniqueKeys();
  const filename = uniqueMediaName(clean.name, taken);
  const mediaRecord = {
    filename,
    blob: file, // Store as Blob directly (File extends Blob)
    mimeType: file.type,
    size: file.size,
    tags: [],
    uploadedAt: new Date().toISOString()
  };

  const id = await db.media.add(mediaRecord);
  return { id, ...mediaRecord };
}

/**
 * Replace an image's bytes in place: the record keeps its id, its name (and
 * so every `attachment:<name>` reference in the documents, which show the
 * new image at once), its tags, its upload date and its sync identity; the
 * blob, the type and the size are the new file's, and `updatedAt` marks
 * the edit (the sync tables read it as the record's time, so another device
 * takes the replacement as an edit of the same record, not a deletion and a
 * new one). The new file must be an image of the SAME type as the current
 * one - .jpg and .jpeg being one type - by its declared MIME type and by
 * its bytes' signature where the format has one: the exports write each
 * image under its stored name, extension included, and a different type
 * under the old name would give files whose extension does not match their
 * content. Resolves to the updated record (with a fresh `data` URL);
 * rejects with a message for the user when the file is not acceptable.
 * @param {number} id - The media id
 * @param {File|Blob} file - The new image
 */
export async function replaceMedia(id, file) {
  const record = await db.media.get(id);
  if (!record) throw new Error('This image is no longer in the library.');
  const refused = replaceRefusal(record, file, await readImageHead(file));
  if (refused) throw new Error(refused);
  const updatedAt = new Date().toISOString();
  // the same type by the rule above, so the record's own spelling stays (image/jpeg for a file declared image/jpg)
  await db.media.update(id, { blob: file, mimeType: record.mimeType || file.type, size: file.size, updatedAt });
  const url = objectUrlCache.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrlCache.delete(id);
  }
  const fresh = await db.media.get(id);
  return { ...fresh, tags: Array.isArray(fresh.tags) ? fresh.tags : [], data: getObjectUrl(fresh) };
}

/** The first bytes of a file (enough for every image signature), as a Uint8Array. */
export async function readImageHead(file) {
  return new Uint8Array(await file.slice(0, 512).arrayBuffer());
}

/**
 * Why `file` may not replace `record`, as a sentence for the user, or null
 * when it may: not an image; a different image type (by the declared type,
 * or by the bytes' signature when the format has one); `head` is the file's
 * first bytes.
 */
export function replaceRefusal(record, file, head) {
  const want = record.mimeType || '';
  const label = imageTypeLabel(want) || 'image';
  if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) return `Replace with a ${label} image (the current image is a ${label}).`;
  if (!sameImageType(file.type, want)) return `Replace with a ${label} image (the current image is a ${label}).`;
  const sniffed = head ? sniffImageType(head) : null;
  if (sniffed && !sameImageType(sniffed, want)) return `Replace with a ${label} image (the current image is a ${label}; this file's content is ${imageTypeLabel(sniffed) || sniffed}).`;
  return null;
}

/**
 * Get all media files
 * @returns {Promise<Array>} Array of media records with displayable URLs.
 * `data` is an object URL pointing at the stored blob (cheap to create,
 * cached per record) — usable anywhere a normal image URL is.
 */
export async function getAllMedia() {
  const records = await db.media.toArray();
  return records.map((record) => ({
    ...record,
    tags: Array.isArray(record.tags) ? record.tags : [],
    data: getObjectUrl(record)
  }));
}

/**
 * Get media by filename
 * @param {string} filename - The filename to search for
 * @returns {Promise<Object|null>} The media record or null
 */
export async function getMediaByFilename(filename) {
  return await db.media.where('filename').equals(filename).first();
}

/**
 * Delete media by id
 * @param {number} id - The media id
 */
export async function deleteMedia(id) {
  await db.media.delete(id);
  const url = objectUrlCache.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrlCache.delete(id);
  }
}

/**
 * Replace the tags on a media record
 * @param {number} id - The media id
 * @param {string[]} tags - New tags (trimmed, deduplicated, empties dropped)
 * @returns {Promise<string[]>} The normalized tags that were stored
 */
export async function updateMediaTags(id, tags) {
  const normalized = [...new Set(
    (tags || []).map((tag) => String(tag).trim()).filter(Boolean)
  )];
  await db.media.update(id, { tags: normalized });
  return normalized;
}

/**
 * Search media by filename
 * @param {string} query - Search query
 * @returns {Promise<Array>} Matching media records
 */
export async function searchMedia(query) {
  const allMedia = await getAllMedia();
  const lowerQuery = query.toLowerCase();
  return allMedia.filter(m => m.filename.toLowerCase().includes(lowerQuery));
}

/**
 * Scan every document's markdown content for attachment: references and
 * report which media filenames are in use, and by which documents.
 *
 * Computed on demand (a full scan of documents' content) rather than kept as
 * a persisted index — document edits can add/remove references at any time,
 * so a stored index could go stale. The scan is a regex pass over in-memory
 * strings and stays in the low milliseconds even for hundreds of documents.
 *
 * @returns {Promise<Map<string, Array<{id: number, title: string}>>>}
 *   Map from media filename to the (unique) documents referencing it.
 */
export async function getMediaUsage() {
  const documents = await db.documents.toArray();
  const usage = new Map();
  // Matches attachment:<filename>; stops at ')', quote, whitespace or '?'
  // so the optional ?width=NNN resize suffix is excluded from the filename.
  const refPattern = /attachment:([^)\s?'"]+)/g;

  for (const doc of documents) {
    if (typeof doc.content !== 'string' || doc.content.length === 0) continue;
    const seen = new Set();
    for (const match of doc.content.matchAll(refPattern)) {
      const filename = match[1];
      if (seen.has(filename)) continue;
      seen.add(filename);
      let docs = usage.get(filename);
      if (!docs) {
        docs = [];
        usage.set(filename, docs);
      }
      docs.push({ id: doc.id, title: doc.title || 'Untitled' });
    }
  }

  return usage;
}

/**
 * Convert Blob to data URL
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Get data URL for media filename (for rendering in markdown)
 * @param {string} filename
 * @returns {Promise<string|null>} Data URL or null if not found
 */
export async function getMediaDataUrl(filename) {
  const media = await getMediaByFilename(filename);
  if (!media) return null;
  return await blobToDataURL(media.blob);
}
