#!/usr/bin/env python3
"""
The self-hosted server's release check (backend/update_check.py), without
GitHub: a fake fetch records every request, a temp file stands in for
<server home>/update-check.json, a fake clock drives the once-a-day rule.

Proves:
  - version parsing/comparison and the reduction of the GitHub answer to
    published vX.Y.Z releases, newest first;
  - the notes shown are every version between the running one and the newest;
  - the automatic check is OFF by default and makes no request; the manual
    check (the admin's "Check now") works while it is off; turned on it makes
    one request a day; turned off again it stops; JACARIUM_UPDATE_CHECK=on
    in the environment turns it on too;
  - the request carries nothing identifying (fixed URL, Accept + a
    version-less User-Agent only);
  - offline / a bad answer: recorded, nothing raised, the last good result kept.

Run:  python3 tests/update_check_backend.test.py   (no Flask needed for these parts)
Exit code 0 = all checks passed, 1 = failure (details on stdout).
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'backend'))

try:
    import update_check as uc  # noqa: E402
except ImportError as error:  # Flask is imported for the blueprint
    print('SKIP: backend/update_check.py needs Flask (%s)' % error)
    sys.exit(0)

results = []


def check(name, ok, detail=''):
    results.append(ok)
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, (' | ' + str(detail)[:300]) if detail else ''))


DAY = 24 * 60 * 60


def release(tag, **extra):
    r = {
        'tag_name': tag, 'name': 'Jacarium ' + tag[1:], 'body': 'notes for ' + tag, 'draft': False, 'prerelease': False,
        'published_at': '2026-10-%02dT10:00:00Z' % (10 + int(''.join(ch for ch in (tag.split('.') + ['0', '0', '0'])[2] if ch.isdigit()) or 0)),
        'html_url': 'https://github.com/jacarium/jacarium/releases/tag/' + tag,
    }
    r.update(extra)
    return r


# ---------- pure helpers ----------
check('parse_version accepts v3.1.9 / 3.1.9, rejects the rest', uc.parse_version('v3.1.9') == (3, 1, 9) and uc.parse_version('3.10.0') == (3, 10, 0) and uc.parse_version('3.1') is None and uc.parse_version('v3.1.9-rc1') is None)
check('compare_versions orders numerically', uc.compare_versions('3.1.10', '3.1.9') > 0 and uc.compare_versions('3.1.9', 'v3.1.9') == 0 and uc.compare_versions('x', '0.0.1') < 0)
releases = uc.normalize_releases([release('v3.2.0'), release('v3.1.9'), release('v3.3.0', draft=True), release('v3.4.0-beta.1', prerelease=True), release('nightly'), release('v3.2.1'), release('v2.6.0')])
check('normalize_releases keeps published vX.Y.Z only, newest first', [r['version'] for r in releases] == ['3.2.1', '3.2.0', '3.1.9', '2.6.0'], [r['version'] for r in releases])
check('normalize_releases tolerates garbage', uc.normalize_releases(None) == [] and uc.normalize_releases({'message': 'rate limited'}) == [] and uc.normalize_releases([None, 1]) == [])
check('releases_newer_than 3.1.9 = 3.2.1, 3.2.0', [r['version'] for r in uc.releases_newer_than(releases, '3.1.9')] == ['3.2.1', '3.2.0'])
notes = uc.notes_since(releases, '3.1.9')
check('notes_since: every version in between, newest first, dated', notes == '## Version 3.2.1 (2026-10-11)\n\nnotes for v3.2.1\n\n## Version 3.2.0 (2026-10-10)\n\nnotes for v3.2.0\n', json.dumps(notes))
check('notes_since: nothing newer -> empty', uc.notes_since(releases, '3.2.1') == '')
check('is_check_due: never -> due; 23h -> not; 24h -> due', uc.is_check_due(None, 1e9) and not uc.is_check_due(1e9 - 23 * 3600, 1e9) and uc.is_check_due(1e9 - DAY, 1e9))

# ---------- the checker ----------
tmp = tempfile.mkdtemp(prefix='update-check-backend-')
store = os.path.join(tmp, 'update-check.json')
state = {'clock': 1_800_000_000.0, 'requests': [], 'answer': lambda: [release('v3.2.0'), release('v3.1.9')]}


def fetch_json(url, headers, timeout):
    state['requests'].append({'url': url, 'headers': headers, 'timeout': timeout})
    return state['answer']()


env = {}
c = uc.UpdateChecker('3.1.9', store, fetch_json=fetch_json, now=lambda: state['clock'], env=env)

s0 = c.status()
check('default: off, nothing known', s0['autoCheck'] is False and s0['updateAvailable'] is False and s0['lastCheckedAt'] is None)
c.tick()
check('default: the scheduled tick makes NO request', state['requests'] == [])
manual = c.check(manual=True)
check('manual check with the setting off: one request, finds 3.2.0', len(state['requests']) == 1 and manual['updateAvailable'] and manual['latestVersion'] == '3.2.0')
req = state['requests'][0]
check('the request: fixed URL, Accept + version-less User-Agent only, a timeout', req['url'] == uc.RELEASES_API_URL and sorted(req['headers']) == ['Accept', 'User-Agent'] and req['headers']['User-Agent'] == 'jacarium-update-check' and not any(ch.isdigit() for ch in req['headers']['User-Agent']) and req['timeout'] == uc.REQUEST_TIMEOUT_S)
check('the result is persisted', json.load(open(store))['releases'][0]['version'] == '3.2.0')
c.tick()
check('still off: no request on tick', len(state['requests']) == 1)

c.set_auto_check(True)
state['clock'] += 1000
c.tick()
check('turned on: a tick right after a check waits a day', len(state['requests']) == 1)
state['clock'] += DAY
state['answer'] = lambda: [release('v3.2.1'), release('v3.2.0'), release('v3.1.9')]
c.tick()
check('turned on, a day later: one request, 3.2.1 found', len(state['requests']) == 2 and c.status()['latestVersion'] == '3.2.1' and c.status()['releases'][0]['version'] == '3.2.1')
state['clock'] += DAY / 2
c.tick()
check('half a day later: no request', len(state['requests']) == 2)
c.set_auto_check(False)
state['clock'] += 3 * DAY
c.tick()
check('turned off: no request however much time passes', len(state['requests']) == 2 and c.status()['autoCheck'] is False)

env['JACARIUM_UPDATE_CHECK'] = 'on'
c.tick()
check('JACARIUM_UPDATE_CHECK=on turns it on without the setting', len(state['requests']) == 3 and c.status()['autoCheckFromEnvironment'] is True)
del env['JACARIUM_UPDATE_CHECK']

# ---------- failures ----------
c.set_auto_check(True)
state['clock'] += DAY


def boom():
    raise OSError('Name or service not known')


state['answer'] = boom
offline = c.tick()
check('offline: nothing raised, the error recorded, the last good result kept', offline is not None and 'service not known' in offline['lastError'] and offline['latestVersion'] == '3.2.1')
state['clock'] += 60
c.tick()
check('offline: the failed check counts as today\'s (no retry storm)', len(state['requests']) == 4)
state['clock'] += DAY
state['answer'] = lambda: {'message': 'API rate limit exceeded'}
limited = c.tick()
check('a rate-limit body: no releases, nothing raised', len(state['requests']) == 5 and limited['lastError'] is None and limited['latestVersion'] is None)
state['clock'] += DAY
state['answer'] = lambda: [release('v3.2.1'), release('v3.1.9')]
c.tick()
check('back online: releases again, error clear', c.status()['latestVersion'] == '3.2.1' and c.status()['lastError'] is None)

import shutil  # noqa: E402
shutil.rmtree(tmp, ignore_errors=True)
failed = results.count(False)
print('\n%d/%d checks passed' % (len(results) - failed, len(results)))
sys.exit(1 if failed else 0)
