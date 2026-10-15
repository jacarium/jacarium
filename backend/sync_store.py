"""
The account's synchronised data on the server (``~/sync.sqlite`` under the
account's home, see user_context.py): one row per record of the app's
database, so every device of the account converges on the same set.

    records   collection, key (the record's syncId), rev (server-assigned,
              +1 per accepted write), seq (server-assigned, global per
              account, strictly increasing: the change feed), updated_at
              (the writing device's timestamp, clamped to the server clock),
              deleted (a tombstone keeps the key so the deletion reaches
              every device), device, body (JSON), received_at
    versions  a superseded body kept whenever a concurrent edit lost or
              overwrote one (restorable), capped per record

Rules (the same as "import with merge", src/utils/importDatabase.js, plus
what synchronisation needs):
  - a write is accepted outright when the device based it on the record's
    current rev (``baseRev == rev``) or the record is new: the ORDER of
    writes is the server's, device clocks play no part;
  - two devices that both edited the same rev (concurrent, e.g. offline)
    are decided by the newer ``updated_at`` (strictly newer wins); the
    losing body is kept in ``versions`` either way, and the loser is told
    (``conflict`` + the winner) so it can keep its own copy too;
  - a deletion is a write like any other (a tombstone with its own
    updated_at): a newer edit resurrects, an older one is dropped;
  - a device's ``updated_at`` in the future beyond a small skew is clamped
    to the server's clock, so a wrong clock cannot win every conflict.
"""
import json
import os
import sqlite3
import threading
import time

from user_context import expand_user_path

MAX_SKEW_SECONDS = 300
MAX_VERSIONS_PER_RECORD = 10
MAX_BODY_BYTES = 16 * 1024 * 1024
MAX_PULL = 500

_SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
    collection TEXT NOT NULL,
    key TEXT NOT NULL,
    rev INTEGER NOT NULL,
    seq INTEGER NOT NULL UNIQUE,
    updated_at REAL NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    device TEXT,
    body TEXT,
    received_at REAL NOT NULL,
    conflict_device TEXT,
    conflict_rev INTEGER,
    PRIMARY KEY (collection, key)
);
CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT NOT NULL,
    key TEXT NOT NULL,
    rev INTEGER NOT NULL,
    updated_at REAL,
    deleted INTEGER NOT NULL DEFAULT 0,
    device TEXT,
    body TEXT,
    saved_at REAL NOT NULL,
    reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_record ON versions(collection, key, id);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

_locks = {}
_locks_guard = threading.Lock()


class SyncError(ValueError):
    pass


def _lock_for(path):
    with _locks_guard:
        lock = _locks.get(path)
        if lock is None:
            lock = threading.Lock()
            _locks[path] = lock
        return lock


class SyncStore:
    """One account's store. Open per request (cheap: SQLite file handle)."""

    def __init__(self, path=None):
        self.path = path or expand_user_path('~/sync.sqlite')
        directory = os.path.dirname(self.path)
        os.makedirs(directory, exist_ok=True)
        existed = os.path.exists(self.path)
        self.conn = sqlite3.connect(self.path, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('PRAGMA journal_mode=WAL')
        self.conn.executescript(_SCHEMA)
        if not existed:
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
        self._lock = _lock_for(self.path)

    def close(self):
        self.conn.close()

    # ------------------------------------------------------------------
    def generation(self):
        """
        Bumped by reset(): a device whose generation is older must empty
        its synchronised tables instead of pushing them back (the account's
        data was deleted on purpose - see account_data.py).
        """
        row = self.conn.execute("SELECT value FROM meta WHERE key = 'generation'").fetchone()
        return int(row[0]) if row else 1

    def reset(self, now=None):
        """Remove every record and version; returns the new generation."""
        now = time.time() if now is None else now
        with self._lock:
            self.conn.execute('BEGIN IMMEDIATE')
            try:
                self.conn.execute('DELETE FROM records')
                self.conn.execute('DELETE FROM versions')
                generation = self.generation() + 1
                self.conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('generation', ?)", (str(generation),))
                self.conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('resetAt', ?)", (str(now),))
                self.conn.execute('COMMIT')
            except Exception:
                self.conn.execute('ROLLBACK')
                raise
        return generation

    def live_records(self):
        """Every record that is not a tombstone, oldest first."""
        rows = self.conn.execute('SELECT * FROM records WHERE deleted = 0 ORDER BY seq').fetchall()
        return [self._public(r) for r in rows]

    def latest_seq(self):
        row = self.conn.execute('SELECT MAX(seq) FROM records').fetchone()
        return int(row[0] or 0)

    def _next_seq(self):
        return self.latest_seq() + 1

    @staticmethod
    def _clamp(updated_at, now):
        try:
            value = float(updated_at)
        except (TypeError, ValueError):
            return now * 1000.0
        # milliseconds since the epoch (the app's Date.now()); seconds are
        # accepted too and normalised
        if value < 1e11:
            value *= 1000.0
        limit = (now + MAX_SKEW_SECONDS) * 1000.0
        return min(value, limit)

    def _row(self, collection, key):
        return self.conn.execute('SELECT * FROM records WHERE collection = ? AND key = ?', (collection, key)).fetchone()

    def _save_version(self, row, reason, now, body=None, updated_at=None, deleted=None, device=None):
        self.conn.execute(
            'INSERT INTO versions (collection, key, rev, updated_at, deleted, device, body, saved_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (row['collection'], row['key'], row['rev'],
             row['updated_at'] if updated_at is None else updated_at,
             row['deleted'] if deleted is None else (1 if deleted else 0),
             row['device'] if device is None else device,
             row['body'] if body is None else body, now, reason))
        self.conn.execute(
            'DELETE FROM versions WHERE collection = ? AND key = ? AND id NOT IN '
            '(SELECT id FROM versions WHERE collection = ? AND key = ? ORDER BY id DESC LIMIT ?)',
            (row['collection'], row['key'], row['collection'], row['key'], MAX_VERSIONS_PER_RECORD))

    @staticmethod
    def _public(row):
        return {
            'collection': row['collection'],
            'key': row['key'],
            'rev': row['rev'],
            'seq': row['seq'],
            'updatedAt': row['updated_at'],
            'deleted': bool(row['deleted']),
            'device': row['device'],
            'body': json.loads(row['body']) if row['body'] else None,
            # set when this revision won over a concurrent edit: the device
            # whose revision it displaced keeps its own version as a copy
            'conflict': ({'device': row['conflict_device'], 'rev': row['conflict_rev']} if row['conflict_device'] else None),
        }

    # ------------------------------------------------------------------
    def push(self, changes, device, now=None):
        """
        Apply a device's changes. Each: {collection, key, baseRev, updatedAt,
        deleted, body}. Returns a result per change in order:
          {status: 'ok', rev, seq}                 accepted
          {status: 'conflict', winner: {...}}      a concurrent edit won;
                                                  the device's body was kept
                                                  as a version
          {status: 'error', error}
        """
        now = time.time() if now is None else now
        results = []
        device = (str(device) if device else 'unknown')[:128]
        with self._lock:
            for change in changes or []:
                try:
                    results.append(self._apply_one(change, device, now))
                except SyncError as exc:
                    results.append({'status': 'error', 'error': str(exc)})
        return results

    def _apply_one(self, change, device, now):
        if not isinstance(change, dict):
            raise SyncError('change must be an object')
        collection = change.get('collection')
        key = change.get('key')
        if not isinstance(collection, str) or not collection or not isinstance(key, str) or not key or len(key) > 256 or len(collection) > 64:
            raise SyncError('collection and key are required')
        deleted = bool(change.get('deleted'))
        body = change.get('body')
        if not deleted and not isinstance(body, dict):
            raise SyncError('body must be an object')
        body_text = None if deleted else json.dumps(body, separators=(',', ':'))
        if body_text is not None and len(body_text) > MAX_BODY_BYTES:
            raise SyncError('record is too large')
        try:
            base_rev = int(change.get('baseRev') or 0)
        except (TypeError, ValueError):
            raise SyncError('baseRev must be a number')
        updated_at = self._clamp(change.get('updatedAt'), now)
        existing = self._row(collection, key)

        conflict_device = None
        conflict_rev = None
        self.conn.execute('BEGIN IMMEDIATE')
        try:
            if existing is not None and existing['rev'] > base_rev:
                # concurrent: the device never saw rev `existing.rev`
                if updated_at > existing['updated_at']:
                    self._save_version(existing, 'overwritten by a concurrent edit', now)
                    conflict_device, conflict_rev = existing['device'], existing['rev']
                    accepted = True
                else:
                    # the device's version is kept, restorable
                    self._save_version(existing, 'lost a concurrent edit', now,
                                       body=body_text, updated_at=updated_at, deleted=deleted, device=device)
                    self.conn.execute('COMMIT')
                    return {'status': 'conflict', 'winner': self._public(existing)}
            else:
                accepted = True
            if accepted:
                rev = (existing['rev'] + 1) if existing is not None else 1
                seq = self._next_seq()
                if existing is not None:
                    self.conn.execute(
                        'UPDATE records SET rev = ?, seq = ?, updated_at = ?, deleted = ?, device = ?, body = ?, received_at = ?, conflict_device = ?, conflict_rev = ? WHERE collection = ? AND key = ?',
                        (rev, seq, updated_at, 1 if deleted else 0, device, body_text, now, conflict_device, conflict_rev, collection, key))
                else:
                    self.conn.execute(
                        'INSERT INTO records (collection, key, rev, seq, updated_at, deleted, device, body, received_at, conflict_device, conflict_rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        (collection, key, rev, seq, updated_at, 1 if deleted else 0, device, body_text, now, conflict_device, conflict_rev))
                self.conn.execute('COMMIT')
                return {'status': 'ok', 'rev': rev, 'seq': seq}
        except Exception:
            try:
                self.conn.execute('ROLLBACK')
            except sqlite3.OperationalError:
                pass
            raise

    # ------------------------------------------------------------------
    def pull(self, since=0, limit=MAX_PULL):
        """Changes after `since`, oldest first; {changes, seq, more}."""
        try:
            since = int(since or 0)
        except (TypeError, ValueError):
            since = 0
        limit = max(1, min(int(limit or MAX_PULL), MAX_PULL))
        rows = self.conn.execute('SELECT * FROM records WHERE seq > ? ORDER BY seq LIMIT ?', (since, limit + 1)).fetchall()
        more = len(rows) > limit
        rows = rows[:limit]
        return {
            'changes': [self._public(r) for r in rows],
            'seq': rows[-1]['seq'] if rows else since,
            'latest': self.latest_seq(),
            'more': more,
            'generation': self.generation(),
        }

    def get(self, collection, key):
        row = self._row(collection, key)
        return self._public(row) if row else None

    def versions(self, collection, key):
        rows = self.conn.execute(
            'SELECT * FROM versions WHERE collection = ? AND key = ? ORDER BY id DESC', (collection, key)).fetchall()
        return [{
            'id': r['id'], 'rev': r['rev'], 'updatedAt': r['updated_at'], 'deleted': bool(r['deleted']),
            'device': r['device'], 'savedAt': r['saved_at'], 'reason': r['reason'],
            'body': json.loads(r['body']) if r['body'] else None,
        } for r in rows]

    def counts(self):
        row = self.conn.execute('SELECT COUNT(*), SUM(deleted) FROM records').fetchone()
        return {'records': int(row[0] or 0), 'tombstones': int(row[1] or 0), 'latest': self.latest_seq(), 'generation': self.generation()}
