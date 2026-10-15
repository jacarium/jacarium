/**
 * Stable cross-machine record identity.
 *
 * Dexie auto-increment `id`s are per-machine and meaningless in an export
 * file, and "natural" keys like title+category break as soon as a record is
 * renamed or moved to another category. A stable id is a UUID minted exactly
 * once when the record is created, stored alongside it, and carried through
 * export/import so two databases can recognize "this is the same record"
 * regardless of any later rename/recategorize.
 *
 * This is deliberately distinct from `cloudDocumentId` (which identifies a
 * shared Yjs collaboration room and only exists on cloud-shared documents)
 * and mirrors the kanban cards' `yjsId` precedent, whose generator delegates
 * here.
 */

/**
 * Generate a globally-unique stable id. Uses crypto.randomUUID() where
 * available (Electron renderer is a secure context, as is Node for tests),
 * with a UUID-shaped fallback for any environment that lacks it.
 */
export function generateStableId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: RFC-4122-ish v4 string built from Math.random.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
