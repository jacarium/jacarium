/**
 * Images in the Documents JSON export/import.
 *
 * Documents reference images BY FILENAME: `![alt](attachment:<filename>)`
 * (optionally `?width=...`), resolved at render time through
 * db.media.where('filename') - see media.js getMediaByFilename and
 * interactiveMarkdown.js. The media table has no stable cross-machine id
 * (auto-increment `id`), so the filename is the only identity an export
 * can carry, exactly as the database backup (exportDatabase.js /
 * importDatabase.js merge) already treats it.
 *
 * Export (attachReferencedMedia, used by every Documents JSON/Base64 export
 * in DocumentSidebar: Export All, Export Category, Export Document, Export
 * as Base64): every document gets a `media` array with
 * the images ITS content references, each encoded like the database
 * backup's media rows - `data` is a base64 data URL
 * (`data:image/png;base64,...`), plus filename/mimeType/size/uploadedAt/
 * tags. Only referenced images are included; an image shared by several
 * documents is embedded in each of them (so any single document in the
 * file is self-contained); a referenced image that is not in the media
 * library is reported as a warning and the link is left as it is.
 *
 * Import (importDocumentMedia): per document, each media entry is
 *   - added to the media library when no local image has that filename;
 *   - reused (nothing written) when a local image has the same filename
 *     AND the same bytes;
 *   - stored under a new filename (`name-2.png`, `name-3.png`, ...) when a
 *     DIFFERENT local image already owns that filename, and the document's
 *     `attachment:` links are rewritten to the new name so they keep
 *     pointing at the imported image rather than the local stranger (when
 *     an earlier import already stored this image as `name-2.png`, the
 *     links are pointed there and nothing is written).
 *
 * The file stays a plain JSON array of documents, so files written before
 * images existed import unchanged (no `media` key = no images) and older
 * app versions import the text of the new files and simply ignore `media`.
 */

import { db } from '../db/database';
import { sanitizeMediaName, imageExtensions } from './mediaNames';
import { formatBytes } from './exportHelpers';

// Same pattern as media.js getMediaUsage: stops at ')', quote, whitespace
// or '?' so the optional ?width= suffix is not part of the filename.
const REF_PATTERN = /attachment:([^)\s?'"]+)/g;

// Above this many encoded bytes the export log warns: base64 adds ~33% and
// the whole file must fit in one JSON string on import; the ZIP export
// stores images as files instead.
export const LARGE_IMAGE_EXPORT_BYTES = 25 * 1024 * 1024;

/** Unique image filenames a document's markdown references, in order. */
export function findAttachmentFilenames(content) {
  if (typeof content !== 'string' || content.length === 0) return [];
  const seen = new Set();
  for (const match of content.matchAll(REF_PATTERN)) seen.add(match[1]);
  return [...seen];
}

const b64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

/**
 * Blob -> base64 data URL, the encoding exportDatabase.js uses for media
 * (`data:<mime>;base64,...`). Reads the bytes with Blob.arrayBuffer() so
 * it works on any Blob implementation; falls back to FileReader.
 */
export async function blobToDataURL(blob, mimeType) {
  const type = blob.type || mimeType || 'application/octet-stream';
  if (typeof blob.arrayBuffer === 'function') {
    return `data:${type};base64,${b64(new Uint8Array(await blob.arrayBuffer()))}`;
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Add a `media` array (the referenced images, encoded) to each document.
 * Progress/warnings go to `onProgress` in the ExportProgressModal shape
 * ({ label, current, total, log, logType }). Returns new document objects;
 * the input is not mutated.
 * @param {Array} docs - documents WITH content
 * @param {Function|null} onProgress
 * @returns {Promise<{ docs: Array, stats: { images: number, embedded: number, bytes: number, missing: Array<{ filename: string, title: string }> } }>}
 */
export async function attachReferencedMedia(docs, onProgress = null) {
  const report = (u) => { if (onProgress) onProgress(u); };
  const label = 'Collecting images';
  const stats = { images: 0, embedded: 0, bytes: 0, missing: [] };
  const encoded = new Map(); // filename -> entry (encode a shared image once)
  const out = [];
  report({ label, current: 0, total: docs.length });
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const title = doc.title || 'Untitled';
    const media = [];
    for (const filename of findAttachmentFilenames(doc.content)) {
      let entry = encoded.get(filename);
      if (entry === undefined) {
        const record = await db.media.where('filename').equals(filename).first();
        if (record && record.blob) {
          const data = await blobToDataURL(record.blob, record.mimeType);
          entry = {
            filename: record.filename,
            mimeType: record.mimeType || record.blob.type || 'application/octet-stream',
            size: record.size ?? record.blob.size,
            uploadedAt: record.uploadedAt,
            tags: Array.isArray(record.tags) ? record.tags : [],
            data,
          };
          stats.images += 1;
          stats.bytes += data.length;
        } else {
          entry = null;
        }
        encoded.set(filename, entry);
      }
      if (entry) {
        media.push(entry);
        stats.embedded += 1;
      } else if (!stats.missing.some((m) => m.filename === filename && m.title === title)) {
        stats.missing.push({ filename, title });
        report({ log: `Image "${filename}" referenced by "${title}" is not in the media library - link kept, image skipped`, logType: 'warning' });
      }
    }
    out.push(media.length > 0 ? { ...doc, media } : { ...doc });
    report({ label, current: i + 1, total: docs.length });
  }
  if (stats.images > 0) {
    report({ log: `Embedded ${stats.images} image${stats.images !== 1 ? 's' : ''} (${formatBytes(stats.bytes)} encoded${stats.embedded !== stats.images ? `, ${stats.embedded} references` : ''})` });
    if (stats.bytes > LARGE_IMAGE_EXPORT_BYTES) {
      report({ log: `Images make this file large (${formatBytes(stats.bytes)} of base64). Export Category (ZIP) stores them as files instead.`, logType: 'warning' });
    }
  }
  return { docs: out, stats };
}

/** The unique image filenames carried by an import file's `media` entries. */
export function countImportImages(items) {
  if (!Array.isArray(items)) return 0;
  const names = new Set();
  for (const item of items) {
    if (!item || !Array.isArray(item.media)) continue;
    for (const m of item.media) {
      if (m && typeof m.filename === 'string' && m.filename) names.add(m.filename);
    }
  }
  return names.size;
}

const isDataUrl = (v) => typeof v === 'string' && /^data:[^,]*;base64,/.test(v);

const equalBytes = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * An import session: the write sink (importDatabase.js createWriter - a
 * dry run's writer stores nothing) plus the images this session has
 * already added (filename -> bytes). The in-session index is what makes a
 * dry run see its own additions (an image shared by two documents is
 * "added" once and "reused" by the second document, exactly as in the real
 * run, where the DB would show it), so both runs plan the same way.
 */
export function newImportSession(writer = null) {
  return {
    writer: writer || { dryRun: false, add: (table, record) => table.add(record) },
    mediaIndex: new Map(),
  };
}

// Local image bytes under a filename: added earlier in this session, else
// the media library.
async function localImageBytes(session, filename) {
  const inSession = session.mediaIndex.get(filename);
  if (inSession) return inSession;
  const record = await db.media.where('filename').equals(filename).first();
  if (!record || !record.blob || typeof record.blob.arrayBuffer !== 'function') return record ? new Uint8Array(0) : null;
  return new Uint8Array(await record.blob.arrayBuffer());
}

/**
 * Where to put an image whose filename a DIFFERENT local image owns: the
 * first `name-N.ext` that is free - or, when an earlier import already
 * stored this very image under one of those names, that name (`existing:
 * true`), so re-importing the same file reuses it instead of adding
 * name-3, name-4, ... copies.
 */
async function collisionTarget(session, filename, bytes) {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}${ext}`;
    const existing = await localImageBytes(session, candidate);
    if (existing === null) return { name: candidate, existing: false };
    if (equalBytes(existing, bytes)) return { name: candidate, existing: true };
  }
}

/** Rewrite every `attachment:<from>` reference (keeping any ?width= suffix) to `attachment:<to>`. */
export function rewriteAttachmentReferences(content, from, to) {
  if (typeof content !== 'string' || from === to) return content;
  return content.replace(REF_PATTERN, (match, name) => (name === from ? `attachment:${to}` : match));
}

/**
 * Bring a document's embedded images into the media library (see the
 * module comment for the rules) and return the content with references
 * rewritten where an image had to be renamed. Nothing is written for a
 * document without `media`. Every write goes through `session.writer`, so
 * the dry run (no-op writer) and the real import share this code.
 * @param {object} documentData - import item ({ content, media?, ... })
 * @param {object} [session] - newImportSession(writer); a fresh real-write session by default
 * @returns {Promise<{ content: string, imported: string[], reused: string[], renamed: Array<[string, string]>, skipped: Array<{ filename: string, reason: string }> }>}
 */
export async function importDocumentMedia(documentData, session = newImportSession()) {
  const result = { content: typeof documentData?.content === 'string' ? documentData.content : '', imported: [], reused: [], renamed: [], skipped: [] };
  const media = Array.isArray(documentData?.media) ? documentData.media : [];
  const done = new Set();
  for (const entry of media) {
    const filename = entry && typeof entry.filename === 'string' ? entry.filename : '';
    if (!filename || done.has(filename)) {
      if (!filename) result.skipped.push({ filename: '(no filename)', reason: 'media entry has no filename' });
      continue;
    }
    done.add(filename);
    if (!isDataUrl(entry.data)) {
      result.skipped.push({ filename, reason: 'media entry has no base64 data to restore the file from' });
      continue;
    }
    let blob;
    try {
      // Same decoder as the database import (kept a dynamic import so the
      // Documents page bundle does not pull the whole DB importer in).
      const { dataURLToBlob } = await import('./importDatabase');
      blob = dataURLToBlob(entry.data);
    } catch {
      result.skipped.push({ filename, reason: 'media entry data is not valid base64' });
      continue;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // The stored name follows the library's rules (src/utils/mediaNames.js), like an upload: an import file is
    // untrusted input, and a name it carries may hold what no upload can produce. A changed name is a rename
    // for the document's references, like a collision.
    const type = imageExtensions(entry.mimeType) ? entry.mimeType : blob.type;
    const clean = sanitizeMediaName(filename, type);
    if (clean.error) {
      result.skipped.push({ filename, reason: `image name refused: ${clean.error}` });
      continue;
    }
    let storeAs = clean.name;
    const local = await localImageBytes(session, storeAs);
    if (local && equalBytes(local, bytes)) {
      result.reused.push(filename);
      if (storeAs !== filename) result.content = rewriteAttachmentReferences(result.content, filename, storeAs);
      continue;
    }
    if (local) {
      const target = await collisionTarget(session, storeAs, bytes);
      storeAs = target.name;
      if (target.existing) {
        // The same image already lives under the renamed name: point the
        // links there and write nothing
        result.reused.push(filename);
        result.content = rewriteAttachmentReferences(result.content, filename, storeAs);
        continue;
      }
    }
    await session.writer.add(db.media, {
      filename: storeAs,
      blob,
      mimeType: entry.mimeType || blob.type || 'application/octet-stream',
      size: typeof entry.size === 'number' ? entry.size : blob.size,
      tags: Array.isArray(entry.tags) ? entry.tags.filter((t) => typeof t === 'string') : [],
      uploadedAt: typeof entry.uploadedAt === 'string' ? entry.uploadedAt : new Date().toISOString(),
    });
    session.mediaIndex.set(storeAs, bytes);
    if (local || storeAs !== filename) {
      result.renamed.push([filename, storeAs]);
      result.content = rewriteAttachmentReferences(result.content, filename, storeAs);
    } else {
      result.imported.push(filename);
    }
  }
  return result;
}
