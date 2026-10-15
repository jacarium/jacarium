/**
 * The label Settings shows for a sync safety snapshot (src/sync/syncEngine.js,
 * _syncSnapshots): the reason and the moment it was taken, in the locale's
 * date and time format - "Before first sync - 13 Oct 2026, 14:02".
 *
 * Rows written before the `kind` field existed carry only the reason text;
 * their kind is read from it.
 */
export const SNAPSHOT_KINDS = {
  'first-sync': 'Before first sync',
  'server-deletion': 'Before server deletion',
};

export function snapshotKind(snapshot) {
  if (snapshot?.kind && SNAPSHOT_KINDS[snapshot.kind]) return snapshot.kind;
  return /deleted on the server|emptied itself/i.test(snapshot?.reason || '') ? 'server-deletion' : 'first-sync';
}

export function snapshotWhen(createdAt) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return date.toLocaleString();
  }
}

export function snapshotLabel(snapshot) {
  return `${SNAPSHOT_KINDS[snapshotKind(snapshot)]} - ${snapshotWhen(snapshot?.createdAt)}`;
}
