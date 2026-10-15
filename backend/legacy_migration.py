"""
Adopting a container's pre-accounts data when the first admin is created.

Before ``JACARIUM_AUTH_MODE=accounts`` the container kept one set of
files for everyone under /data (its HOME): the settings file with the API
keys, one Taskwarrior database, one known_hosts, the SSH identities, the
Google Calendar token. When the first (admin) account is created those are
adopted - COPIED, never moved or deleted - like this:

    /data/.jacarium.env          -> /data/settings.env (server defaults:
                                           every account inherits these keys
                                           until it sets its own)
    /data/.task/ and /data/.taskrc      -> <admin home>/.task/ and .taskrc
                                           (data.location rewritten)
    /data/.ssh/known_hosts, id_*        -> <admin home>/.ssh/
    /data/.jacarium-gcal-token.pickle -> <admin home>/
    /data/.jacarium/vector_db    left alone (the admin re-indexes;
                                           ids in it belong to one browser)

A marker, /data/migrated-to-accounts.json, records what was done; a second
call does nothing. Each step is skipped when its destination already
exists (an operator may have prepared the account's home by hand).

Why the settings become *server defaults* rather than the admin's own:
those keys served every browser of the container, so leaving them shared
keeps the integrations working for every account on day one; the admin can
move a key to their own settings (Settings > Integrations) whenever they
want it private.
"""
import glob
import json
import os
import shutil
import time

from user_context import server_home

MARKER_NAME = 'migrated-to-accounts.json'


def _copy_file(src, dst, mode=None):
    if not os.path.isfile(src) or os.path.exists(dst):
        return False
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    if mode is not None:
        os.chmod(dst, mode)
    return True


def _rewrite_taskrc(path, data_location):
    lines = []
    found = False
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        for raw in fh:
            if raw.strip().startswith('data.location='):
                lines.append(f'data.location={data_location}\n')
                found = True
            else:
                lines.append(raw)
    if not found:
        lines.insert(0, f'data.location={data_location}\n')
    with open(path, 'w', encoding='utf-8') as fh:
        fh.writelines(lines)


def migrate_container_data(admin_home, *, server=None, log=print):
    """
    Adopt the pre-accounts files for the first admin. Returns a dict of what
    happened (also written to the marker). Never raises for a missing
    source; a copy error is recorded and the rest continues.
    """
    server = server or server_home()
    marker = os.path.join(server, MARKER_NAME)
    if os.path.exists(marker):
        try:
            with open(marker, 'r', encoding='utf-8') as fh:
                previous = json.load(fh)
        except Exception:
            previous = {}
        previous['skipped'] = 'already migrated'
        return previous

    report = {'at': time.time(), 'adminHome': admin_home, 'copied': [], 'skipped': [], 'errors': []}

    def step(label, fn):
        try:
            done = fn()
            (report['copied'] if done else report['skipped']).append(label)
            if done:
                log(f'[Accounts] adopted pre-accounts data: {label}')
        except Exception as exc:
            report['errors'].append(f'{label}: {exc}')
            log(f'[Accounts] WARNING: could not adopt {label}: {exc}')

    # 1. the shared settings become the server defaults
    step('settings -> server defaults (settings.env)',
         lambda: _copy_file(os.path.join(server, '.jacarium.env'), os.path.join(server, 'settings.env'), 0o600))

    # 2. the Taskwarrior database and rc file go to the admin
    def copy_tasks():
        src = os.path.join(server, '.task')
        dst = os.path.join(admin_home, '.task')
        if not os.path.isdir(src) or os.path.exists(dst):
            return False
        if not any(os.scandir(src)):
            return False
        shutil.copytree(src, dst)
        return True
    step('Taskwarrior data (.task/)', copy_tasks)

    def copy_taskrc():
        src = os.path.join(server, '.taskrc')
        dst = os.path.join(admin_home, '.taskrc')
        if not _copy_file(src, dst):
            return False
        _rewrite_taskrc(dst, os.path.join(admin_home, '.task'))
        return True
    step('Taskwarrior configuration (.taskrc)', copy_taskrc)

    # 3. SSH: the accepted host keys and any identities
    def copy_ssh():
        src_dir = os.path.join(server, '.ssh')
        if not os.path.isdir(src_dir):
            return False
        dst_dir = os.path.join(admin_home, '.ssh')
        os.makedirs(dst_dir, mode=0o700, exist_ok=True)
        os.chmod(dst_dir, 0o700)
        copied = False
        src_kh = os.path.join(src_dir, 'known_hosts')
        if os.path.isfile(src_kh) and os.path.getsize(src_kh) > 0:
            copied = _copy_file(src_kh, os.path.join(dst_dir, 'known_hosts'), 0o600) or copied
        for key in glob.glob(os.path.join(src_dir, 'id_*')):
            mode = 0o644 if key.endswith('.pub') else 0o600
            copied = _copy_file(key, os.path.join(dst_dir, os.path.basename(key)), mode) or copied
        return copied
    step('SSH known_hosts and identities (.ssh/)', copy_ssh)

    # 4. the Google Calendar token
    step('Google Calendar token',
         lambda: _copy_file(os.path.join(server, '.jacarium-gcal-token.pickle'),
                            os.path.join(admin_home, '.jacarium-gcal-token.pickle'), 0o600))

    try:
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            json.dump(report, fh, indent=2)
    except OSError as exc:
        report['errors'].append(f'marker: {exc}')
    return report
