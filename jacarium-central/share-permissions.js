/**
 * Who may WRITE to a shared document or board - the server's own record.
 *
 * Sharing is visible to the whole team by design (every authenticated
 * identity receives every shared item), but editing is not: the owner grants
 * Read & Write per identity in the app's permissions modal. Until this module
 * existed that grant lived only inside the item's payload and was enforced
 * only by the receiving UI (DocumentEditor / KanbanPage go read-only), so a
 * modified client could still write to the live Yjs document of anything it
 * had received. The server now keeps its own copy of owner + permissions
 * per Yjs room and yjs-sync.js refuses updates from anyone else.
 *
 * Keys are the Yjs room ids: a document's cloudDocumentId, a board's
 * cloudBoardId. (Workflows have no live edit channel; their records are
 * keyed by "workflow:" + sha256(ownerId + "\n" + title), the same hashed
 * shape yjs-persistence.js uses, and matter only for the upload paths.)
 *
 * The record is learned from the OWNER's uploads (socket upload-document /
 * upload-board and POST /api/documents / /api/kanban/boards): the owner's
 * client re-uploads on every "Share with the Team", on every permission
 * change and on autosave, so the record follows the owner's intent closely.
 * Only the owner's upload may change it; a Read & Write member's re-upload
 * ("Sync Changes") is accepted by the upload paths (checkSharedUpload) but
 * never touches the record. Identity renames (POST /api/reown) rewrite the record like the
 * queue; removal (remove-* / DELETE) forgets it.
 *
 * LEGACY ITEMS: an item shared before this record existed has no entry, and
 * the server cannot invent an owner for it - the removal index maps a hash
 * of (owner, title) to the id, by design without the owner in clear. Such a
 * room stays as open as it was (every authenticated member may write) until
 * the owner's next upload creates its record; from then on it is enforced.
 * No existing document is ever locked for its owner.
 *
 * ON DISK: DATA_DIR/share-permissions.json, mode 0600, atomic tmp+rename
 * (the client-registry.js pattern), plain JSON like clients.json: it holds
 * identities and room ids, no content and no titles. Loaded once at
 * startup; kept regardless of YJS_STORAGE_ENCRYPTION_KEY, because
 * enforcement must also hold in memory-only mode.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, checkUploadOwnership } = require('./client-registry');

const FILE = path.join(DATA_DIR, 'share-permissions.json');

/** { [roomId]: { ownerId, permissions: { [identity]: 'read' | 'write' }, kind } } */
let records = null;

function load() {
  if (records !== null) return;
  records = {};
  try {
    if (fs.existsSync(FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const [id, rec] of Object.entries(parsed)) {
          if (rec && typeof rec.ownerId === 'string') {
            records[id] = { ownerId: rec.ownerId, permissions: normalizePermissions(rec.permissions), kind: rec.kind || 'document' };
          }
        }
      }
    }
  } catch (error) {
    console.error(`[SharePermissions] Failed to load ${FILE}:`, error.message);
    records = {};
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmpFile = `${FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(records, null, 2), { mode: 0o600 });
    fs.renameSync(tmpFile, FILE);
  } catch (error) {
    console.error('[SharePermissions] Failed to save share permissions:', error.message);
  }
}

/** Only string identities with a value of 'read' or 'write' survive; anything else is dropped. */
function normalizePermissions(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [identity, level] of Object.entries(map)) {
    if (typeof identity !== 'string' || !identity) continue;
    if (level === 'read' || level === 'write') out[identity] = level;
  }
  return out;
}

function samePermissions(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** The record key of an uploaded item, or null when the payload carries no usable id. */
function roomIdOf(kind, payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (kind === 'document') return typeof payload.cloudDocumentId === 'string' && payload.cloudDocumentId ? payload.cloudDocumentId : null;
  if (kind === 'board') return typeof payload.cloudBoardId === 'string' && payload.cloudBoardId ? payload.cloudBoardId : null;
  if (kind === 'workflow') {
    if (typeof payload.ownerId !== 'string' || typeof payload.title !== 'string' || !payload.title) return null;
    return 'workflow:' + crypto.createHash('sha256').update(`${payload.ownerId}\n${payload.title}`, 'utf8').digest('hex');
  }
  return null;
}

/**
 * The OWNER uploaded an item: (re)record who may write to it. Returns the
 * record. No-op without a usable id.
 */
function recordFromOwnerUpload(kind, payload) {
  const id = roomIdOf(kind, payload);
  if (!id) return null;
  load();
  const next = { ownerId: payload.ownerId, permissions: normalizePermissions(payload.permissions), kind };
  const prev = records[id];
  if (prev && prev.ownerId !== next.ownerId) {
    // A room already recorded under another owner is never re-recorded by
    // someone else's upload (checkSharedUpload refuses such an upload; this
    // is the record's own last line).
    return prev;
  }
  if (prev && prev.kind === next.kind && samePermissions(prev.permissions, next.permissions)) {
    return prev; // no churn on autosave re-uploads
  }
  records[id] = next;
  save();
  return next;
}

function getRecord(roomId) {
  load();
  return records[roomId] || null;
}

/**
 * May `identity` write to this room? { allowed, known }: `known` is false for
 * a legacy room without a record (allowed by compatibility, see the header).
 */
function canWrite(roomId, identity) {
  const rec = getRecord(roomId);
  if (!rec) return { allowed: true, known: false };
  return { allowed: rec.ownerId === identity || rec.permissions[identity] === 'write', known: true };
}

function forget(roomId) {
  load();
  if (roomId && roomId in records) {
    delete records[roomId];
    save();
    return true;
  }
  return false;
}

/** Forget every record of the workflows this owner shares (removal carries owner + title only). */
function forgetWorkflow(ownerId, title) {
  return forget(roomIdOf('workflow', { ownerId, title }));
}

/** An identity became another one (POST /api/reown): owner and grants follow it. */
function renameIdentity(oldId, newId) {
  load();
  let changed = 0;
  // (A workflow record's key hashes the OLD owner's name; the title is not
  // known here, so it keeps its key. It only mattered for the retired
  // identity's uploads, and nothing can be written to a workflow live.)
  for (const rec of Object.values(records)) {
    let touched = false;
    if (rec.ownerId === oldId) { rec.ownerId = newId; touched = true; }
    if (Object.prototype.hasOwnProperty.call(rec.permissions, oldId)) {
      rec.permissions[newId] = rec.permissions[oldId];
      delete rec.permissions[oldId];
      touched = true;
    }
    if (touched) changed++;
  }
  if (changed) save();
  return changed;
}

/**
 * The upload check of the shared-item paths (socket upload-document /
 * upload-workflow / upload-board and the matching POST routes), in place of
 * the bare checkUploadOwnership:
 *   - the OWNER's upload is accepted as before and (re)records who may edit -
 *     unless the room is already recorded under ANOTHER owner: a member
 *     cannot take a room over by re-sending it with their own ownerId;
 *   - a Read & Write member's re-upload ("Sync Changes") is accepted when
 *     the payload keeps the owner's ownerId and exactly the recorded
 *     permission map - a member may change the content, never who owns the
 *     item or who may edit it; the record is not touched;
 *   - everything else is refused with checkUploadOwnership's reasons
 *     (forged ownerId, a smuggled removal marker, an unknown item for a
 *     non-owner - the strict rule when there is no record).
 * Returns null when acceptable, otherwise an error message.
 */
function checkSharedUpload(kind, payload, machineId) {
  if (!payload || typeof payload !== 'object') return 'Invalid payload';
  if (payload._type !== undefined) return checkUploadOwnership(payload, machineId); // its refusal, its reasons
  const rec = getRecord(roomIdOf(kind, payload));
  if (payload.ownerId === machineId) {
    if (rec && rec.ownerId !== machineId) {
      console.log(`[Auth] ❌ ${machineId} tried to re-share "${payload.title}" as their own; it is shared by "${rec.ownerId}" - rejected`);
      return 'Permission denied: this item is shared by another identity';
    }
    recordFromOwnerUpload(kind, payload);
    return null;
  }
  if (rec && rec.ownerId === payload.ownerId) {
    if (rec.permissions[machineId] !== 'write') {
      console.log(`[Auth] ❌ ${machineId} tried to sync "${payload.title}" shared by "${payload.ownerId}" without Read & Write - rejected`);
      return 'Permission denied: you can view this item but not sync changes to it';
    }
    if (!samePermissions(normalizePermissions(payload.permissions), rec.permissions)) {
      console.log(`[Auth] ❌ ${machineId} tried to change the permissions of "${payload.title}" shared by "${payload.ownerId}" - rejected (owner only)`);
      return 'Permission denied: only the owner may change who can edit';
    }
    return null;
  }
  return checkUploadOwnership(payload, machineId); // a forged ownerId: logged and refused there
}

module.exports = {
  FILE,
  checkSharedUpload,
  normalizePermissions,
  samePermissions,
  roomIdOf,
  recordFromOwnerUpload,
  getRecord,
  canWrite,
  forget,
  forgetWorkflow,
  renameIdentity
};
