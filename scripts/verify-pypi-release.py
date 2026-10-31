#!/usr/bin/env python3
"""
The checks the security lane asks for before a PyPI release younger than the 7-day cooldown is locked
(backend/lock-requirements.sh --past-cooldown NAME==VERSION; SECURITY.md, "Dependency policy"): the Python
counterpart of scripts/urgent-dep-update.cjs. It downloads nothing but the two releases' files into a temporary
directory, installs nothing, and prints a report that goes into docs/security/urgent-updates.md.

    scripts/verify-pypi-release.py pyasn1 0.6.4 0.6.5
    scripts/verify-pypi-release.py pyasn1 0.6.4 0.6.5 --diff --compare-tag pyasn1/pyasn1@v0.6.5
    scripts/verify-pypi-release.py NAME OLD NEW [--min-age-days 2] [--wheel TAG] [--keep DIR] [--pypi-url URL]

For NEW against OLD (the version the lock holds) it reports, and flags in red:
  - the age: the upload time of NEW's files; younger than --min-age-days (2, the lane's floor) is a red flag -
    under that only on the maintainer's explicit decision, which this script does not take;
  - the publisher: PyPI's PEP 740 provenance of every file (the Trusted Publisher's repository, workflow and
    environment) when the project publishes one - a different publisher than OLD's, or provenance missing where
    OLD had it, is a red flag; without provenance, the release metadata's author / maintainer against OLD's (a
    change is a red flag) and, best effort, the maintainer accounts on the project page;
  - the digests: every downloaded file's sha256 against what the index says (a mismatch is a red flag);
  - the sdist and one wheel of each version diffed: files added / removed / changed; a changed or added
    setup.py / build backend, and new subprocess / network / eval / ctypes / environment / encoded-payload use
    in a changed or added module (tests and docs excepted) are red flags; --diff prints the unified diff of
    the changed modules;
  - the dependencies (Requires-Dist): any addition, removal or range change is a red flag;
  - --compare-tag OWNER/REPO@TAG (or a tarball URL): the import packages in the sdist and in the wheel against
    the project's git tag - a difference is a red flag, which is the check to run where there is no provenance.

Exit 0 with "no red flag", 1 when there is one (each printed as RED FLAG: ...), 2 on a usage or network
error. Standard library only; --pypi-url and --now exist for the test, which serves a fake index locally.
"""
import argparse
import datetime as dt
import difflib
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
import zipfile

LANE_MIN_AGE_DAYS = 2
DANGEROUS = [
    ('subprocess', re.compile(r'\bsubprocess\b|\bos\.(system|popen|exec[lv]p?e?|spawn[lv]p?e?)\b')),
    ('network', re.compile(r'\bsocket\b|\burllib\b|\bhttp\.client\b|\brequests\b|\bhttpx\b|\baiohttp\b')),
    ('eval', re.compile(r'\beval\(|\bexec\(|\bcompile\(|__import__\(|importlib\.import_module')),
    ('ctypes', re.compile(r'\bctypes\b|\bcffi\b')),
    ('env', re.compile(r'\bos\.environ\b|\bos\.getenv\b')),
    ('encoded payload', re.compile(r'base64\.b64decode|\bmarshal\.loads|\bzlib\.decompress')),
]
SKIP_DIRS = re.compile(r'^(tests?|testing|docs?|examples?|benchmarks?)/')
BUILD_FILES = ('setup.py', 'setup.cfg', 'pyproject.toml')


class Fail(Exception):
    pass


# ----------------------------------------------------------------- the index
def fetch(url, accept=None, timeout=60):
    req = urllib.request.Request(url, headers={'Accept': accept} if accept else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise Fail(f'{url}: HTTP {e.code}')
    except urllib.error.URLError as e:
        raise Fail(f'{url}: {e.reason}')


def release(base, name, version):
    body = fetch(f'{base}/pypi/{name}/{version}/json')
    if body is None:
        raise Fail(f'{name} {version} is not on the index')
    return json.loads(body)


def provenance(base, name, version, filename):
    """PEP 740: [{kind, repository, workflow, environment, attestations}] per bundle, or None when there is none."""
    body = fetch(f'{base}/integrity/{name}/{version}/{filename}/provenance', accept='application/vnd.pypi.integrity.v1+json')
    if body is None:
        return None
    doc = json.loads(body)
    out = []
    for b in doc.get('attestation_bundles') or []:
        p = b.get('publisher') or {}
        out.append({'kind': p.get('kind', ''), 'repository': p.get('repository', ''), 'workflow': p.get('workflow', ''),
                    'environment': p.get('environment', ''), 'attestations': len(b.get('attestations') or [])})
    return out


def project_maintainers(base, name):
    """The maintainer accounts on the project page, best effort (the page may sit behind a challenge)."""
    try:
        body = fetch(f'{base}/project/{name}/', accept='text/html', timeout=20)
    except Fail:
        return None
    if not body:
        return None
    text = body.decode('utf-8', 'replace')
    names = re.findall(r'class="sidebar-section__maintainer"\s+href="/user/([^/"]+)/"', text)
    return sorted(set(names)) or None


def pick_files(rel, wheel_tag):
    """(sdist, wheel) entries of a release: the sdist, and the wheel whose name carries wheel_tag (None if absent)."""
    sdist = next((u for u in rel['urls'] if u.get('packagetype') == 'sdist'), None)
    wheels = [u for u in rel['urls'] if u.get('packagetype') == 'bdist_wheel']
    wheel = next((u for u in wheels if wheel_tag in u['filename']), None) if wheel_tag else None
    if wheel is None and wheels and not wheel_tag:
        wheel = next((u for u in wheels if 'none-any' in u['filename']), wheels[0])
    return sdist, wheel


def download(entry, into):
    data = fetch(entry['url'])
    if data is None:
        raise Fail(f'{entry["url"]}: not found')
    path = os.path.join(into, entry['filename'])
    with open(path, 'wb') as fh:
        fh.write(data)
    got = hashlib.sha256(data).hexdigest()
    want = (entry.get('digests') or {}).get('sha256', '')
    return path, got, want


# ----------------------------------------------------------------- the trees
def unpack(path, into):
    """The files of an archive as {relative path: bytes}; an sdist's single top directory is stripped,
    a wheel's <name>-<version>.dist-info directory is renamed DIST-INFO so two versions compare."""
    files = {}
    if path.endswith('.whl') or path.endswith('.zip'):
        with zipfile.ZipFile(path) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                rel = re.sub(r'^[^/]+\.dist-info/', 'DIST-INFO/', info.filename)
                files[rel] = z.read(info)
    else:
        with tarfile.open(path, 'r:*') as t:
            t.extractall(into, filter='data')
            for root, _dirs, names in os.walk(into):
                for n in names:
                    full = os.path.join(root, n)
                    rel = os.path.relpath(full, into).replace(os.sep, '/')
                    rel = rel.split('/', 1)[1] if '/' in rel else rel
                    with open(full, 'rb') as fh:
                        files[rel] = fh.read()
    return files


def tree_diff(old, new):
    added = sorted(f for f in new if f not in old)
    removed = sorted(f for f in old if f not in new)
    changed = sorted(f for f in new if f in old and old[f] != new[f])
    return added, removed, changed


def text(b):
    return b.decode('utf-8', 'replace')


def is_module(rel):
    return rel.endswith('.py') and not SKIP_DIRS.match(rel) and not re.search(r'/(tests?|testing)/', rel)


def dangerous_usage(old, new, files):
    out = []
    for f in files:
        if not is_module(f) and f not in BUILD_FILES:
            continue
        after = text(new[f])
        before = text(old[f]) if f in old else ''
        for label, rx in DANGEROUS:
            n, o = len(rx.findall(after)), len(rx.findall(before))
            if n > o:
                out.append(f'{f}: {label} usage {o} -> {n}')
    return out


def build_backend(files):
    m = re.search(r'^\s*build-backend\s*=\s*["\']([^"\']+)', text(files.get('pyproject.toml', b'')), re.M)
    return m.group(1) if m else ''


def top_level_packages(wheel_files):
    names = text(wheel_files.get('DIST-INFO/top_level.txt', b'')).split()
    if names:
        return names
    return sorted({f.split('/', 1)[0] for f in wheel_files if '/' in f and not f.startswith('DIST-INFO/')})


def requires(rel):
    return sorted(re.sub(r'\s+', ' ', r.strip()) for r in (rel['info'].get('requires_dist') or []))


def unified(old, new, f):
    a = text(old[f]).splitlines(keepends=True) if f in old else []
    b = text(new[f]).splitlines(keepends=True)
    return ''.join(difflib.unified_diff(a, b, fromfile=f'{f} (old)', tofile=f'{f} (new)'))


def tag_archive_url(spec):
    if re.match(r'^https?://', spec):
        return spec
    m = re.match(r'^([^/@]+)/([^/@]+)@([^@]+)$', spec)
    if not m:
        raise Fail(f'--compare-tag takes OWNER/REPO@TAG or a tarball URL, got {spec!r}')
    return f'https://github.com/{m.group(1)}/{m.group(2)}/archive/refs/tags/{m.group(3)}.tar.gz'


def compare_with_tag(url, packages, sdist_files, wheel_files, into):
    """For each import package: the files under it in the tag archive against the sdist and the wheel."""
    data = fetch(url)
    if data is None:
        raise Fail(f'{url}: not found')
    path = os.path.join(into, 'tag.tar.gz')
    with open(path, 'wb') as fh:
        fh.write(data)
    tag = unpack(path, os.path.join(into, 'tag'))
    report, flags = [], []
    for pkg in packages:
        want = {f: b for f, b in tag.items() if f.startswith(pkg + '/') and f.endswith('.py')}
        if not want:
            flags.append(f'the tag archive has no {pkg}/ package')
            continue
        for label, files in (('sdist', sdist_files), ('wheel', wheel_files)):
            if files is None:
                continue
            have = {f: b for f, b in files.items() if f.startswith(pkg + '/') and f.endswith('.py')}
            a, r, c = tree_diff(want, have)
            if a or r or c:
                flags.append(f'{label}: {pkg}/ differs from the tag ({len(a)} added, {len(r)} missing, {len(c)} changed: {", ".join((a + r + c)[:6])})')
            else:
                report.append(f'   {label}: {pkg}/ ({len(want)} modules) identical to the tag')
    return report, flags


# ----------------------------------------------------------------- the run
def parse_iso(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00'))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0], formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__.split('\n', 2)[2])
    ap.add_argument('name')
    ap.add_argument('old', help='the version the lock holds')
    ap.add_argument('new', help='the version to verify')
    ap.add_argument('--min-age-days', type=float, default=LANE_MIN_AGE_DAYS, help=f'the lane floor (default {LANE_MIN_AGE_DAYS})')
    ap.add_argument('--wheel', default='', metavar='TAG', help='the wheel to compare, by a tag in its file name (default: the pure wheel, else the first)')
    ap.add_argument('--diff', action='store_true', help='print the unified diff of every changed module')
    ap.add_argument('--compare-tag', metavar='OWNER/REPO@TAG', help='compare the import packages with the git tag (GitHub, or a tarball URL)')
    ap.add_argument('--keep', metavar='DIR', help='keep the downloaded files in DIR (default: a temporary directory, removed)')
    ap.add_argument('--pypi-url', default='https://pypi.org', help=argparse.SUPPRESS)
    ap.add_argument('--now', help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    base = args.pypi_url.rstrip('/')
    now = parse_iso(args.now) if args.now else dt.datetime.now(dt.timezone.utc)
    work = args.keep or tempfile.mkdtemp(prefix='verify-pypi-')
    os.makedirs(work, exist_ok=True)
    flags = []
    say = print
    try:
        old_rel, new_rel = release(base, args.name, args.old), release(base, args.name, args.new)
        say(f'== {args.name} {args.old} -> {args.new}')
        # the age
        times = [parse_iso(u['upload_time_iso_8601']) for u in new_rel['urls']]
        if not times:
            raise Fail(f'{args.name} {args.new} has no files')
        uploaded = min(times)
        age = round((now - uploaded).total_seconds() / 86400, 1)
        lane = (f", younger than the lane's {args.min_age_days:g} days" if age < args.min_age_days
                else ', younger than the 7-day cooldown: within the security lane' if age < 7 else '')
        say(f'   uploaded {uploaded.isoformat()} ({age} days old{lane})')
        if age < args.min_age_days:
            flags.append(f"{age} days old, younger than the lane's {args.min_age_days:g} days (under that only on the maintainer's explicit decision)")
        if any(u.get('yanked') for u in new_rel['urls']):
            flags.append('the release is yanked')
        # the publisher
        for label, rel in (('old', old_rel), ('new', new_rel)):
            i = rel['info']
            say(f'   {label} metadata: author {i.get("author") or "-"} <{i.get("author_email") or "-"}>, maintainer {i.get("maintainer") or "-"} <{i.get("maintainer_email") or "-"}>')
        for field in ('author', 'author_email', 'maintainer', 'maintainer_email'):
            if (old_rel['info'].get(field) or '') != (new_rel['info'].get(field) or ''):
                flags.append(f'the release metadata\'s {field} changed: {old_rel["info"].get(field)!r} -> {new_rel["info"].get(field)!r}')
        old_sdist, old_wheel = pick_files(old_rel, args.wheel)
        new_sdist, new_wheel = pick_files(new_rel, args.wheel)
        if new_sdist is None:
            raise Fail(f'{args.name} {args.new} has no sdist')
        prov = {}
        for label, rel, entries in (('old', old_rel, (old_sdist, old_wheel)), ('new', new_rel, (new_sdist, new_wheel))):
            prov[label] = {}
            for e in entries:
                if e is None:
                    continue
                p = provenance(base, args.name, rel['info']['version'], e['filename'])
                prov[label][e['filename']] = p
                if p is None:
                    say(f'   provenance {e["filename"]}: none')
                else:
                    for b in p:
                        say(f'   provenance {e["filename"]}: {b["kind"]} {b["repository"]} {b["workflow"]} environment {b["environment"] or "-"} ({b["attestations"]} attestation(s))')
        def publishers(d):
            return sorted({(b['kind'], b['repository'], b['workflow']) for p in d.values() if p for b in p})
        old_pub, new_pub = publishers(prov['old']), publishers(prov['new'])
        if old_pub and not new_pub:
            flags.append(f'no PEP 740 provenance where {args.old} had it')
        elif old_pub and new_pub and old_pub != new_pub:
            flags.append(f'the Trusted Publisher changed: {old_pub} -> {new_pub}')
        elif new_pub and any(p is None for p in prov['new'].values()):
            flags.append('provenance on some of the new files only')
        if not new_pub:
            accounts = project_maintainers(base, args.name)
            say(f'   project page maintainers: {", ".join(accounts) if accounts else "could not be read - check https://pypi.org/project/" + args.name + "/ by hand"}')
        # the files
        trees = {}
        for label, entries in (('old', (old_sdist, old_wheel)), ('new', (new_sdist, new_wheel))):
            for kind, e in zip(('sdist', 'wheel'), entries):
                if e is None:
                    trees[(label, kind)] = None
                    continue
                path, got, want = download(e, work)
                ok = got == want
                say(f'   {label} {kind} {e["filename"]}: sha256 {got[:16]}... {"= index" if ok else "DIFFERS FROM THE INDEX (" + want + ")"}')
                if not ok:
                    flags.append(f'{e["filename"]}: sha256 {got} differs from the index\'s {want}')
                trees[(label, kind)] = unpack(path, os.path.join(work, f'{label}-{kind}'))
        for kind in ('sdist', 'wheel'):
            old_t, new_t = trees[('old', kind)], trees[('new', kind)]
            if new_t is None:
                say(f'   {kind}: none to compare')
                continue
            if old_t is None:
                say(f'   {kind}: {args.old} has no matching file; every file counts as added')
                old_t = {}
            a, r, c = tree_diff(old_t, new_t)
            say(f'   {kind}: {len(old_t)} -> {len(new_t)} files, {len(c)} changed, {len(a)} added, {len(r)} removed')
            for f in c:
                say(f'     ~ {f}')
            for f in a:
                say(f'     + {f}')
            for f in r:
                say(f'     - {f}')
            if kind == 'sdist':
                for f in ('setup.py',):
                    if f in a:
                        flags.append(f'{f} added')
                ob, nb = build_backend(old_t), build_backend(new_t)
                if ob != nb:
                    flags.append(f'the build backend changed: {ob or "-"} -> {nb or "-"}')
                for f in BUILD_FILES:
                    if f in c:
                        say(f'   {f} changed (read it: a build hook runs at install time)')
            for d in dangerous_usage(old_t, new_t, a + c):
                flags.append(f'{kind}: new {d}')
            if args.diff:
                for f in a + c:
                    if is_module(f) or f in BUILD_FILES:
                        say(f'   --- diff {kind} {f}')
                        for line in unified(old_t, new_t, f).splitlines():
                            say(f'   {line}')
        # the dependencies
        o_req, n_req = requires(old_rel), requires(new_rel)
        say(f'   requires: {len(o_req)} -> {len(n_req)} entries')
        for entry in sorted(set(n_req) - set(o_req)):
            flags.append(f'dependency added or changed: {entry}')
        for entry in sorted(set(o_req) - set(n_req)):
            flags.append(f'dependency removed or changed: {entry}')
        if (old_rel['info'].get('requires_python') or '') != (new_rel['info'].get('requires_python') or ''):
            say(f'   requires-python {old_rel["info"].get("requires_python") or "-"} -> {new_rel["info"].get("requires_python") or "-"}')
        # the tag
        if args.compare_tag:
            packages = top_level_packages(trees[('new', 'wheel')] or {}) or [args.name.replace('-', '_')]
            rep, fl = compare_with_tag(tag_archive_url(args.compare_tag), packages, trees[('new', 'sdist')], trees[('new', 'wheel')], work)
            for line in rep:
                say(line)
            flags.extend(fl)
    except Fail as e:
        say(f'error: {e}')
        return 2
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)
    say('')
    if flags:
        for f in flags:
            say(f'RED FLAG: {f}')
        say(f'{len(flags)} red flag(s): read them before locking {args.name}=={args.new}')
        return 1
    say('no red flag')
    return 0


if __name__ == '__main__':
    sys.exit(main())
