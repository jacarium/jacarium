/**
 * Identity renames announced by the central server (`identity-renamed`):
 * a teammate's identity moved to another one - local copies of what it
 * owned, and the permissions it granted, follow the new name.
 */
import { db } from '../db/database';

const OWNED_TABLES = ['documents', 'workflows', 'kanbanBoards', 'taskwarriorInstances'];

/**
 * Rewrite local copies after an identity moved: owner and permission
 * entries of `from` become `to`.
 */
export async function applyIdentityRename({ from, to }) {
  const counts = { owned: 0, permissions: 0 };
  if (!from || !to || from === to) return counts;
  for (const table of OWNED_TABLES) {
    const rows = await db.table(table).toArray();
    for (const row of rows) {
      const changes = {};
      if (row.ownerId === from) { changes.ownerId = to; counts.owned++; }
      if (row.permissions && typeof row.permissions === 'object' && Object.prototype.hasOwnProperty.call(row.permissions, from)) {
        const permissions = { ...row.permissions, [to]: row.permissions[from] };
        delete permissions[from];
        changes.permissions = permissions;
        counts.permissions++;
      }
      if (Object.keys(changes).length) await db.table(table).update(row.id, changes);
    }
  }
  if (counts.owned || counts.permissions) console.log(`[cloudReown] ${from} -> ${to}: ${counts.owned} item(s), ${counts.permissions} permission entr(y/ies) rewritten`);
  return counts;
}
