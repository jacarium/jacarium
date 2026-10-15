/**
 * Encrypted at-rest persistence for Yjs documents.
 *
 * WHY THIS EXISTS: yjs-sync.js evicts idle Y.Docs from memory after a grace
 * period (and always lost everything on a server restart). Without disk
 * persistence, the next client to open an evicted document gets a freshly
 * created EMPTY Y.Doc - any edits a currently-offline collaborator never
 * received are gone. This module stores each document's Yjs binary snapshot
 * (Y.encodeStateAsUpdate) on disk, encrypted, so eviction and restarts are
 * survivable. The Yjs binary format is used deliberately: it preserves the
 * CRDT metadata needed for correct future merges (a JSON reconstruction
 * would not).
 *
 * ENCRYPTION KEY - YJS_STORAGE_ENCRYPTION_KEY:
 *   - Format: exactly 64 hexadecimal characters (32 bytes / 256 bits).
 *   - Generate one with:  openssl rand -hex 32
 *     (or ./generate-yjs-key.sh in this directory, or:
 *      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
 *   - Missing key  -> persistence is DISABLED (memory-only mode, one clear
 *     startup warning). The server behaves exactly as it did before this
 *     feature existed: documents do not survive eviction/restart. This is
 *     deliberate ("fail closed" for the sensitive operation only, like
 *     backend/extensions.py's APP_AUTH_TOKEN): an existing deployment
 *     upgrading in place keeps working, and we never silently fall back to
 *     writing PLAINTEXT snapshots.
 *   - Malformed key -> the server REFUSES TO START with a clear error. An
 *     operator who set the variable clearly intended persistence to be on;
 *     silently running memory-only would betray that intent.
 *
 * ON-DISK FORMAT (one file per document: data/documents/<documentId>.ydoc):
 *   byte 0        format version (currently 1)
 *   bytes 1-12    AES-GCM IV (12 random bytes, fresh per write, never reused)
 *   bytes 13-28   GCM auth tag (16 bytes)
 *   bytes 29..    ciphertext of the Yjs update (AES-256-GCM)
 * The documentId is bound as GCM additional authenticated data (AAD), so a
 * snapshot file renamed/copied to another document's filename fails
 * authentication instead of decrypting into the wrong document. The IV and
 * auth tag are not secret - they only need to be unique/available.
 *
 * Writes are atomic (tmp file + rename, same pattern as client-registry.js)
 * so a crash mid-write leaves the previous valid snapshot intact rather
 * than a truncated, undecryptable one.
 *
 * REMOVAL INDEX (data/documents/index.json): the client's remove-document
 * flow identifies a document by (ownerId, title) - it does NOT carry the
 * Yjs documentId (cloudDocumentId). Uploads DO carry all three, so we keep
 * a small persisted index mapping sha256(ownerId + "\n" + title) -> yjs
 * documentId, learned from uploads, purely so removal can delete the right
 * snapshot file. Keys are hashed to avoid storing document titles in
 * plaintext next to encrypted content. This is NOT a retention/pruning
 * policy - snapshots for still-shared idle documents are kept forever by
 * design (small-team tool, disk is cheap).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./client-registry');
const { debugLog } = require('./state');

const DOCUMENTS_DIR = path.join(DATA_DIR, 'documents');
const INDEX_FILE = path.join(DOCUMENTS_DIR, 'index.json');

const KEY_ENV_VAR = 'YJS_STORAGE_ENCRYPTION_KEY';
const FORMAT_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + IV_LENGTH + TAG_LENGTH;

// --- Key validation (at startup - see header comment for the policy) -------
const rawKey = (process.env[KEY_ENV_VAR] || '').trim();
let encryptionKey = null;

if (!rawKey) {
  console.warn(
    `[YjsPersistence] WARNING: ${KEY_ENV_VAR} is not set. Yjs document\n` +
    '[YjsPersistence] persistence is DISABLED (memory-only mode): collaborative\n' +
    '[YjsPersistence] documents will NOT survive idle eviction or a server\n' +
    '[YjsPersistence] restart. To enable encrypted at-rest persistence, set\n' +
    `[YjsPersistence] ${KEY_ENV_VAR} to a 64-character hex string\n` +
    '[YjsPersistence] (generate one with: openssl rand -hex 32).\n' +
    '[YjsPersistence] Snapshots are never written unencrypted.'
  );
} else if (!/^[0-9a-fA-F]{64}$/.test(rawKey)) {
  console.error(
    `[YjsPersistence] FATAL: ${KEY_ENV_VAR} is set but invalid ` +
    `(got ${rawKey.length} chars). Expected exactly 64 hexadecimal characters ` +
    '(32 bytes). Generate a valid key with: openssl rand -hex 32'
  );
  console.error(
    '[YjsPersistence] Refusing to start: a set-but-broken key means the ' +
    'operator intended persistence to be on, and running memory-only ' +
    '(or writing plaintext) would silently betray that.'
  );
  process.exit(1);
} else {
  encryptionKey = Buffer.from(rawKey, 'hex');
  console.log(`[YjsPersistence] Encrypted Yjs document persistence enabled (dir: ${DOCUMENTS_DIR})`);
}

function isPersistenceEnabled() {
  return encryptionKey !== null;
}

// --- Filename safety --------------------------------------------------------
// documentId is expected to be a UUID (the app's cloudDocumentId), but it
// arrives from the network, so validate defensively: only [A-Za-z0-9_-],
// bounded length, no dots/slashes - rules out path traversal, hidden files
// and collision with index.json (which contains a dot).
const SAFE_DOCUMENT_ID = /^[A-Za-z0-9_-]{1,100}$/;

function isSafeDocumentId(documentId) {
  return typeof documentId === 'string' && SAFE_DOCUMENT_ID.test(documentId);
}

function snapshotPath(documentId) {
  return path.join(DOCUMENTS_DIR, `${documentId}.ydoc`);
}

// --- Encrypt / decrypt ------------------------------------------------------

function encryptSnapshot(documentId, plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(Buffer.from(documentId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, tag, ciphertext]);
}

/** Throws on any corruption/tamper/wrong-key (GCM auth failure). */
function decryptSnapshot(documentId, fileBuffer) {
  if (fileBuffer.length < HEADER_LENGTH) {
    throw new Error(`file too short (${fileBuffer.length} bytes) - truncated?`);
  }
  const version = fileBuffer[0];
  if (version !== FORMAT_VERSION) {
    throw new Error(`unknown snapshot format version ${version}`);
  }
  const iv = fileBuffer.subarray(1, 1 + IV_LENGTH);
  const tag = fileBuffer.subarray(1 + IV_LENGTH, HEADER_LENGTH);
  const ciphertext = fileBuffer.subarray(HEADER_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAAD(Buffer.from(documentId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// --- Snapshot read/write/delete --------------------------------------------

/**
 * Persist a Yjs binary update (Y.encodeStateAsUpdate output) for a document.
 * Atomic: tmp file + rename (client-registry.js pattern), so a crash
 * mid-write leaves the previous valid snapshot in place.
 * Returns true if a snapshot was written.
 */
function persistSnapshot(documentId, update) {
  if (!encryptionKey) return false;
  if (!isSafeDocumentId(documentId)) {
    console.warn(`[YjsPersistence] Refusing to persist unsafe documentId: ${JSON.stringify(documentId)}`);
    return false;
  }
  try {
    fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
    const filePath = snapshotPath(documentId);
    const tmpFile = `${filePath}.tmp`;
    fs.writeFileSync(tmpFile, encryptSnapshot(documentId, Buffer.from(update)), { mode: 0o600 });
    fs.renameSync(tmpFile, filePath);
    debugLog(`[YjsPersistence] Persisted snapshot for ${documentId} (${update.length} bytes plaintext)`);
    return true;
  } catch (error) {
    console.error(`[YjsPersistence] Failed to persist snapshot for ${documentId}:`, error.message);
    return false;
  }
}

/**
 * Load a persisted snapshot, distinguishing WHY there might not be one.
 * Returns { snapshot: Buffer|null, loadFailed: boolean }:
 *   - snapshot   the Yjs update bytes, or null when nothing usable exists.
 *   - loadFailed true ONLY when a snapshot file EXISTS but could not be used
 *                (unreadable file, corruption, wrong/rotated key). This is
 *                the case yjs-sync.js marks the document degraded for and
 *                signals to clients. ENOENT (a genuinely new document) and
 *                persistence-disabled are NOT failures.
 * Synchronous by design: this only runs on a COLD miss (once per document per
 * eviction/restart cycle, never per keystroke), so briefly blocking beats
 * threading async through every getYDoc call site. Corrupted/undecryptable
 * files (crash mid-write without the atomic rename, wrong key, tampering) log
 * a clear error - callers fall back to an empty doc instead of crashing the
 * server, but can now tell that empty doc apart from a genuinely new one.
 */
function loadSnapshotWithStatus(documentId) {
  if (!encryptionKey) return { snapshot: null, loadFailed: false };
  if (!isSafeDocumentId(documentId)) return { snapshot: null, loadFailed: false };
  const filePath = snapshotPath(documentId);
  let fileBuffer;
  try {
    fileBuffer = fs.readFileSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return { snapshot: null, loadFailed: false }; // genuinely new document
    console.error(`[YjsPersistence] Failed to read snapshot for ${documentId}:`, error.message);
    return { snapshot: null, loadFailed: true };
  }
  try {
    return { snapshot: decryptSnapshot(documentId, fileBuffer), loadFailed: false };
  } catch (error) {
    console.error(
      `[YjsPersistence] ERROR: snapshot for document ${documentId} is corrupted or ` +
      `undecryptable (${error.message}). This usually means a wrong/changed ` +
      `${KEY_ENV_VAR} or a damaged file. Falling back to an EMPTY document - ` +
      'persisted edits for this document are NOT recoverable without the ' +
      `original key/file (${filePath}).`
    );
    return { snapshot: null, loadFailed: true };
  }
}

/** Back-compat convenience wrapper: just the snapshot bytes (or null). */
function loadSnapshot(documentId) {
  return loadSnapshotWithStatus(documentId).snapshot;
}

/** Delete a document's persisted snapshot (used on explicit cloud removal). */
function deleteSnapshot(documentId) {
  if (!isSafeDocumentId(documentId)) return false;
  try {
    fs.unlinkSync(snapshotPath(documentId));
    console.log(`[YjsPersistence] Deleted persisted snapshot for removed document ${documentId}`);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[YjsPersistence] Failed to delete snapshot for ${documentId}:`, error.message);
    }
    return false;
  }
}

// --- (ownerId, title) -> documentId removal index --------------------------

let documentIndex = null; // lazy-loaded { [sha256(ownerId\ntitle)]: documentId }

function indexKey(ownerId, title) {
  return crypto.createHash('sha256').update(`${ownerId}\n${title}`, 'utf8').digest('hex');
}

function loadIndex() {
  if (documentIndex !== null) return;
  documentIndex = {};
  try {
    if (fs.existsSync(INDEX_FILE)) {
      documentIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    }
  } catch (error) {
    console.error(`[YjsPersistence] Failed to load document index (${INDEX_FILE}):`, error.message);
    documentIndex = {};
  }
}

function saveIndex() {
  try {
    fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
    const tmpFile = `${INDEX_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(documentIndex, null, 2), { mode: 0o600 });
    fs.renameSync(tmpFile, INDEX_FILE);
  } catch (error) {
    console.error('[YjsPersistence] Failed to save document index:', error.message);
  }
}

/** Learned from uploads (which carry ownerId, title AND cloudDocumentId). */
function recordDocumentId(ownerId, title, documentId) {
  if (!encryptionKey) return; // feature fully off without a key
  if (!ownerId || !title || !isSafeDocumentId(documentId)) return;
  loadIndex();
  const key = indexKey(ownerId, title);
  if (documentIndex[key] === documentId) return; // no churn on re-uploads
  documentIndex[key] = documentId;
  saveIndex();
}

/** Resolve a removal's (ownerId, title) to the yjs documentId, if known. */
function lookupDocumentId(ownerId, title) {
  if (!encryptionKey) return null;
  loadIndex();
  return documentIndex[indexKey(ownerId, title)] || null;
}

function forgetDocumentId(ownerId, title) {
  if (!encryptionKey) return;
  loadIndex();
  const key = indexKey(ownerId, title);
  if (key in documentIndex) {
    delete documentIndex[key];
    saveIndex();
  }
}

module.exports = {
  KEY_ENV_VAR,
  DOCUMENTS_DIR,
  isPersistenceEnabled,
  isSafeDocumentId,
  snapshotPath,
  persistSnapshot,
  loadSnapshot,
  loadSnapshotWithStatus,
  deleteSnapshot,
  recordDocumentId,
  lookupDocumentId,
  forgetDocumentId
};
