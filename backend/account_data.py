"""
"Delete all my data on the server" (accounts mode) - and the backups it
leaves behind.

    GET    /api/account/backups                       the account's backups
    GET    /api/account/backups/<name>                download one
    POST   /api/account/data/delete                   {password, confirmUsername, includeFiles}
    GET    /api/admin/users/<id>/backups              (administrators, any account)
    GET    /api/admin/users/<id>/backups/<name>
    POST   /api/admin/users/<id>/data/delete          {password (the admin's own), confirmUsername (the target's), includeFiles}

Unlike Wipe Database (this device only; the data comes back from the
server) this removes the account's synchronised records FROM THE SERVER,
for every device: the sync store is emptied and its generation bumped, so
every browser and linked profile empties those records at its next
synchronisation instead of uploading them again - a device that was
offline too (its push with the old generation is refused with 409 and it
resynchronises from the empty store; src/sync/syncEngine.js).

Before anything is deleted a backup is written under the account
(~/backups/<time>-before-delete.json, Export Database format: Settings >
General > Import Database restores it; the last BACKUP_KEEP are kept) and
offered for download before and after. The per-account files on the
server (Taskwarrior data, SSH keys and known_hosts, the settings file with
the API keys, the calendar token, the RAG index, the reports directory)
are NOT touched unless `includeFiles` is set - then they are archived next
to the backup (<time>-files.tar.gz) and removed; the account itself, its
backups, its central-server pairing and its sync store file stay.

A fresh password is required (a session alone is not enough, and a linked
device's token cannot do it), the action is rate limited and every
deletion is in the audit log.
"""
import io
import json
import os
import re
import shutil
import tarfile
import time

from flask import Blueprint, jsonify, request, send_file

import accounts
from accounts import RateLimiter
from auth import bearer_token, client_ip, require_admin, require_admin_action
from sync_store import SyncStore
from user_context import accounts_mode, current_user, user_home_for

account_data = Blueprint('account_data', __name__)

BACKUP_KEEP = 3
BACKUP_DIR = 'backups'
# home entries removed with includeFiles (everything else under the home stays)
ACCOUNT_FILES = ['.task', '.taskrc', '.ssh', '.jacarium', '.jacarium.env',
                 '.jacarium-gcal-token.pickle', 'reports']
delete_limiter = RateLimiter(3, 60 * 60)

# the sync store's collections as the Export Database file names them, and
# what the file carries for a parent reference (src/utils/mergeCore.js)
EXPORT_KEYS = {
    'documents': 'documents', 'documentCategories': 'documentCategories', 'documentTemplates': 'documentTemplates',
    'templates': 'jqlTemplates', 'engineTemplates': 'engineTemplates', 'workflows': 'workflows',
    'kanbanBoards': 'kanbanBoards', 'kanbanCards': 'kanbanCards', 'taskwarriorInstances': 'taskwarriorInstances',
    'tasks': 'tasks', 'taskwarriorReports': 'taskwarriorReports', 'customReports': 'customReports',
    'calendarEventTemplates': 'calendarEventTemplates', 'sshCommands': 'sshCommands',
    'openshiftTemplates': 'openshiftTemplates', 'gtfobinsFunctions': 'gtfobinsFunctions',
    'gtfobinsExecutables': 'gtfobinsExecutables', 'gtfobinsContexts': 'gtfobinsContexts', 'media': 'media',
}
PARENTS = {'kanbanCards': ('boardId', 'kanbanBoards'), 'tasks': ('instanceId', 'taskwarriorInstances'),
           'taskwarriorReports': ('instanceId', 'taskwarriorInstances')}


def build_export(records):
    """The account's live records as an Export Database file (dict)."""
    by_collection = {}
    for rec in records:
        by_collection.setdefault(rec['collection'], []).append(rec)
    ids = {}        # (collection, key) -> the id used in the file
    out = {key: [] for key in EXPORT_KEYS.values()}
    extra = {}
    # parents first, so children can refer to them
    order = ['kanbanBoards', 'taskwarriorInstances'] + [c for c in by_collection if c not in ('kanbanBoards', 'taskwarriorInstances')]
    for collection in order:
        for n, rec in enumerate(by_collection.get(collection, []), start=1):
            body = dict(rec.get('body') or {})
            if collection in PARENTS:
                field, parent = PARENTS[collection]
                sync_key = body.pop(f'{field}Sync', None)
                parent_id = ids.get((parent, sync_key))
                if parent_id is None:
                    continue    # its parent is gone: not importable
                body[field] = parent_id
            if collection == 'media':
                body['data'] = body.pop('blob', None)
                if not isinstance(body.get('data'), str):
                    continue
            body['id'] = n
            ids[(collection, rec['key'])] = n
            if collection in EXPORT_KEYS:
                out[EXPORT_KEYS[collection]].append(body)
            else:
                extra.setdefault(collection, []).append(body)
    out.update({
        'version': '1.0',
        'formatVersion': 1,
        'exportDate': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'source': 'server backup before "Delete all my data on the server"',
        'customGrids': [], 'customQuizzes': [], 'localStorage': {},
    })
    if extra:
        out['syncExtra'] = extra
    return out


def _backup_dir(home):
    path = os.path.join(home, BACKUP_DIR)
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def _backup_name(name):
    return bool(re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-(before-delete\.json|files\.tar\.gz)', name or ''))


def list_backups(home):
    path = _backup_dir(home)
    out = []
    for name in sorted(os.listdir(path), reverse=True):
        if not _backup_name(name):
            continue
        st = os.stat(os.path.join(path, name))
        out.append({'name': name, 'bytes': st.st_size, 'createdAt': st.st_mtime,
                    'kind': 'files' if name.endswith('.tar.gz') else 'data'})
    return out


def _prune(home):
    path = _backup_dir(home)
    stamps = sorted({n.split('-')[0] for n in os.listdir(path) if _backup_name(n)}, reverse=True)
    for stamp in stamps[BACKUP_KEEP:]:
        for name in os.listdir(path):
            if name.startswith(stamp + '-'):
                os.unlink(os.path.join(path, name))


def write_backups(home, store, include_files):
    """The data backup (always) and the files archive (with include_files); returns their names."""
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    path = _backup_dir(home)
    data_name = f'{stamp}-before-delete.json'
    export = build_export(store.live_records())
    fd = os.open(os.path.join(path, data_name), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        json.dump(export, fh)
    names = [data_name]
    if include_files:
        files_name = f'{stamp}-files.tar.gz'
        fd = os.open(os.path.join(path, files_name), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'wb') as fh, tarfile.open(fileobj=fh, mode='w:gz') as tar:
            for entry in ACCOUNT_FILES:
                full = os.path.join(home, entry)
                if os.path.lexists(full):
                    tar.add(full, arcname=entry)
        names.append(files_name)
    _prune(home)
    return names


def remove_files(home):
    removed = []
    for entry in ACCOUNT_FILES:
        full = os.path.join(home, entry)
        if os.path.islink(full) or os.path.isfile(full):
            os.unlink(full)
            removed.append(entry)
        elif os.path.isdir(full):
            shutil.rmtree(full)
            removed.append(entry)
    return removed


def _delete(target, acting, body):
    """The shared flow; `target` and `acting` are user dicts."""
    if bearer_token():
        return jsonify({'error': 'A linked device cannot do this: sign in with the password in a browser'}), 403
    allowed, retry = delete_limiter.hit(acting['id'])
    if not allowed:
        return jsonify({'error': f'Too many attempts; try again in {retry} seconds', 'retryAfter': retry}), 429
    password = body.get('password') if isinstance(body.get('password'), str) else ''
    if not accounts.check_login(acting['username'], password):
        accounts.audit('data-delete-refused', user=target['username'], by=acting['username'], reason='wrong-password', ip=client_ip())
        return jsonify({'error': 'The password is wrong'}), 403
    if (body.get('confirmUsername') or '').strip().lower() != target['username']:
        return jsonify({'error': f'Type the username ({target["username"]}) to confirm'}), 400
    include_files = bool(body.get('includeFiles'))
    home = user_home_for(target['id'])
    store = SyncStore(os.path.join(home, 'sync.sqlite'))
    try:
        counts_before = store.counts()
        names = write_backups(home, store, include_files)
        generation = store.reset()
    finally:
        store.close()
    removed = remove_files(home) if include_files else []
    accounts.audit('data-deleted', user=target['username'], by=acting['username'], records=counts_before['records'],
                   files=int(include_files), generation=generation, ip=client_ip())
    print(f'[Accounts] {acting["username"]} deleted the server data of {target["username"]}: {counts_before["records"]} record(s), files={include_files}, backup {names[0]}')
    return jsonify({'ok': True, 'generation': generation, 'deleted': {'records': counts_before['records'], 'files': removed},
                    'backups': names, 'backupList': list_backups(home)})


def _send_backup(home, name):
    if not _backup_name(name):
        return jsonify({'error': 'No such backup'}), 404
    path = os.path.join(_backup_dir(home), name)
    if not os.path.isfile(path):
        return jsonify({'error': 'No such backup'}), 404
    with open(path, 'rb') as fh:
        data = fh.read()
    return send_file(io.BytesIO(data), as_attachment=True, download_name=name,
                     mimetype='application/gzip' if name.endswith('.gz') else 'application/json')


def _own():
    if not accounts_mode():
        return None, (jsonify({'error': 'Accounts are not enabled on this server'}), 404)
    user = current_user()
    if not user:
        return None, (jsonify({'error': 'Sign in first'}), 401)
    return user, None


@account_data.route('/api/account/backups', methods=['GET'])
def own_backups():
    user, error = _own()
    if error:
        return error
    return jsonify({'backups': list_backups(user_home_for(user['id'])), 'keep': BACKUP_KEEP})


@account_data.route('/api/account/backups/<name>', methods=['GET'])
def own_backup(name):
    user, error = _own()
    if error:
        return error
    return _send_backup(user_home_for(user['id']), name)


@account_data.route('/api/account/data/delete', methods=['POST'])
def delete_own_data():
    user, error = _own()
    if error:
        return error
    body = request.get_json(silent=True)
    return _delete(user, user, body if isinstance(body, dict) else {})


@account_data.route('/api/admin/users/<user_id>/backups', methods=['GET'])
def admin_backups(user_id):
    refusal = require_admin()
    if refusal:
        return refusal
    target = accounts.get_user(user_id)
    if not target:
        return jsonify({'error': 'No such user'}), 404
    return jsonify({'backups': list_backups(user_home_for(target['id'])), 'keep': BACKUP_KEEP})


@account_data.route('/api/admin/users/<user_id>/backups/<name>', methods=['GET'])
def admin_backup(user_id, name):
    refusal = require_admin_action()
    if refusal:
        return refusal
    target = accounts.get_user(user_id)
    if not target:
        return jsonify({'error': 'No such user'}), 404
    return _send_backup(user_home_for(target['id']), name)


@account_data.route('/api/admin/users/<user_id>/data/delete', methods=['POST'])
def admin_delete_data(user_id):
    refusal = require_admin()
    if refusal:
        return refusal
    target = accounts.get_user(user_id)
    if not target:
        return jsonify({'error': 'No such user'}), 404
    body = request.get_json(silent=True)
    return _delete(target, current_user(), body if isinstance(body, dict) else {})
