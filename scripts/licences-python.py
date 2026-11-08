#!/usr/bin/env python3
"""The Python side of Settings > About > "All open-source licences".

Run by the Python that the build ships (standard library only, `python -I`), so its site-packages
is the truth: the entries - name, version, licence, URL and the licence files of each distribution's
dist-info - for the Python packages one build type REALLY ships, plus the interpreter itself (CPython and
its standard library, PSF-2.0) and, for the installers, the PyInstaller bootloader. Nothing is fetched.

  --mode image    the container: every distribution installed in this environment (/opt/app-root:
                  requirements.txt constrained by requirements.lock, and the venv's pip); --strict checks
                  that every lock entry whose marker applies here is installed at the locked version
  --mode frozen   the installers: the distributions whose files the PyInstaller analysis bundled
                  (--toc backend/build/flask-backend/Analysis-00.toc, mapped through each distribution's
                  RECORD), plus the bootloader; --strict fails on a bundled site-packages file no
                  distribution owns
  --mode venv     a dev checkout: the installed distributions that requirements.lock names (the build
                  tools in the venv - PyInstaller, pip - are not part of the backend)

  --strict        a shipped package without an entry, a lock entry not installed, or no Python licence
                  text is an error (exit 1)
  --merge FILE    merge into a licences.json the UI build wrote (the container's runtime stage);
                  without it the result is printed as JSON (scripts/generate-licences.mjs reads it)
"""
import argparse
import ast
import importlib.metadata as md
import json
import os
import platform
import re
import sys
import sysconfig

LICENCE_FILE = re.compile(r'^(licen[sc]e|copying|notice)([-._].*)?$', re.I)
MAX_TEXT = 60000
LOCK_LINE = re.compile(r'^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)\s*(?:;\s*(.+))?$')
PSF_URL = 'https://docs.python.org/3/license.html'


def norm(name):
    return re.sub(r'[-_.]+', '-', name).lower()


def read_text(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        text = f.read().replace('\r\n', '\n').strip()
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT] + '\n\n[... cut: the full text is in the package]'
    return text


def licence_texts(directory, prefix=''):
    try:
        names = sorted(n for n in os.listdir(directory) if LICENCE_FILE.match(n) and os.path.isfile(os.path.join(directory, n)))
    except OSError:
        return []
    return [{'file': prefix + n, 'text': read_text(os.path.join(directory, n))} for n in names]


def entry_of(dist):
    meta = dist.metadata
    name, version = meta['Name'], dist.version
    licence = (meta.get('License-Expression') or meta.get('License') or '').strip()
    if not licence or licence == 'UNKNOWN' or len(licence) > 80 or '\n' in licence:
        classifiers = [c.split('::')[-1].strip() for c in (meta.get_all('Classifier') or []) if c.startswith('License ::')]
        if classifiers:
            licence = ' / '.join(classifiers)
        elif licence:
            licence = licence.splitlines()[0][:77] + '...'
    url = meta.get('Home-page') or ''
    if not url:
        for pu in meta.get_all('Project-URL') or []:
            label, _, value = pu.partition(',')
            if label.strip().lower() in ('homepage', 'source', 'repository', 'source code'):
                url = value.strip()
                break
    info = str(dist._path) if hasattr(dist, '_path') else ''
    texts = licence_texts(info) + licence_texts(os.path.join(info, 'licenses'), 'licenses/') if info else []
    return {'ecosystem': 'pypi', 'name': name, 'version': version, 'licence': licence, 'url': url, 'texts': texts}


def site_dirs():
    paths = sysconfig.get_paths()
    return sorted({os.path.realpath(paths['purelib']), os.path.realpath(paths['platlib'])})


def installed():
    out = {}
    for d in md.distributions(path=site_dirs()):
        name = d.metadata['Name'] if d.metadata else None
        if name and norm(name) not in out:
            out[norm(name)] = d
    return out


def marker_applies(marker):
    if not marker:
        return True
    env = {
        'platform_python_implementation': platform.python_implementation(),
        'implementation_name': sys.implementation.name,
        'sys_platform': sys.platform,
        'platform_machine': platform.machine(),
        'platform_system': platform.system(),
        'os_name': os.name,
        'python_version': '%d.%d' % sys.version_info[:2],
    }
    expr = re.sub(r'\b(' + '|'.join(env) + r')\b', lambda m: repr(env[m.group(1)]), marker)
    if not re.fullmatch(r"(\s|'[^']*'|\"[^\"]*\"|==|!=|\(|\)|\band\b|\bor\b|\bnot\b)*", expr):
        raise SystemExit(f'[licences-python] cannot evaluate the lock marker: {marker}')
    return bool(eval(expr, {'__builtins__': {}}, {}))   # noqa: S307 - our own lock file's markers, checked above


def lock_entries(lock):
    out = {}
    with open(lock, encoding='utf-8') as f:
        for line in f:
            m = LOCK_LINE.match(line.strip())
            if m and marker_applies(m.group(3)):
                out[norm(m.group(1))] = (m.group(1), m.group(2))
    return out


def python_entry(strict, problems):
    stdlib = sysconfig.get_paths()['stdlib']
    base = sys.base_prefix
    candidates = [os.path.join(stdlib, 'LICENSE.txt'), os.path.join(base, 'LICENSE.txt'), os.path.join(base, 'LICENSE')]
    lic_root = '/usr/share/licenses'
    try:
        for d in sorted(os.listdir(lic_root)):
            if re.fullmatch(r'python3(\.\d+)?(-libs)?', d):
                candidates += [os.path.join(lic_root, d, n) for n in ('LICENSE', 'LICENSE.txt')]
    except OSError:
        pass
    texts = []
    for c in candidates:
        if os.path.isfile(c):
            texts = [{'file': 'LICENSE', 'text': read_text(c)}]
            break
    if not texts:
        problems.append('the Python interpreter\'s LICENSE text was not found (looked in %s)' % ', '.join(candidates))
    return {'ecosystem': 'runtime', 'name': 'Python', 'version': platform.python_version(),
            'licence': 'PSF-2.0', 'url': PSF_URL, 'note': 'the backend\'s runtime: CPython and its standard library',
            'texts': texts}


def toc_paths(toc):
    with open(toc, encoding='utf-8') as f:
        data = ast.literal_eval(f.read())
    paths = set()

    def walk(x):
        if isinstance(x, (list, tuple)):
            if len(x) == 3 and all(isinstance(i, str) for i in x) and x[2] in ('PYMODULE', 'PYSOURCE', 'BINARY', 'EXTENSION', 'DATA', 'SYMLINK'):
                if os.path.isabs(x[1]):
                    paths.add(os.path.realpath(x[1]))
            else:
                for i in x:
                    walk(i)
    walk(data)
    return paths


def frozen(toc, dists, problems):
    owner = {}
    for key, d in dists.items():
        root = os.path.realpath(str(d.locate_file('')))
        for f in d.files or []:
            owner[os.path.realpath(os.path.join(root, str(f)))] = key
    roots = [r + os.sep for r in site_dirs()]
    used, orphans = set(), []
    for p in toc_paths(toc):
        if not any(p.startswith(r) for r in roots):
            continue
        key = owner.get(p)
        if key is None and '__pycache__' in p:   # a .pyc compiled after install: its source's owner
            src = re.sub(r'__pycache__' + re.escape(os.sep) + r'([^.' + re.escape(os.sep) + r']+)\..*\.pyc$', r'\1.py', p)
            key = owner.get(src)
        if key is None:
            orphans.append(p)
        else:
            used.add(key)
    if orphans:
        problems.append('%d bundled site-packages files belong to no installed distribution: %s' % (len(orphans), ', '.join(sorted(orphans)[:4])))
    return used


def bootloader(dists, problems):
    d = dists.get('pyinstaller')
    if not d:
        problems.append('PyInstaller is not installed here, so its bootloader\'s licence cannot be listed')
        return None
    e = entry_of(d)
    e.update({'ecosystem': 'runtime', 'name': 'PyInstaller bootloader', 'licence': 'GPL-2.0-or-later WITH PyInstaller-exception',
              'url': 'https://pyinstaller.org/en/stable/license.html',
              'note': 'the frozen backend\'s launcher and runtime; the GPL\'s bootloader exception allows distributing it with any program'})
    return e


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', choices=('image', 'frozen', 'venv'), required=True)
    ap.add_argument('--lock', required=True)
    ap.add_argument('--toc')
    ap.add_argument('--strict', action='store_true')
    ap.add_argument('--merge')
    a = ap.parse_args()

    problems = []
    dists = installed()
    lock = lock_entries(a.lock)
    if a.mode == 'image':
        keys = set(dists)
    elif a.mode == 'frozen':
        if not a.toc or not os.path.isfile(a.toc):
            raise SystemExit(f'[licences-python] --mode frozen needs the PyInstaller analysis (--toc): {a.toc!r} not found')
        keys = frozen(a.toc, dists, problems) - {'pyinstaller', 'pyinstaller-hooks-contrib'}
    else:
        keys = set(dists) & set(lock)
    # the lock: in the image every applicable entry is installed; frozen and venv list what is there
    if a.mode == 'image':
        for k, (name, version) in sorted(lock.items()):
            if k not in dists:
                problems.append(f'{name}=={version} (requirements.lock) is not installed')
            elif dists[k].version != version:
                problems.append(f'{name} is installed at {dists[k].version}, requirements.lock says {version}')
    packages = []
    for k in sorted(keys):
        try:
            packages.append(entry_of(dists[k]))
        except Exception as exc:   # an unreadable dist-info: shipped, but no entry
            problems.append(f'{k}: no entry ({exc})')
    runtime = [python_entry(a.strict, problems)]
    if a.mode == 'frozen':
        b = bootloader(dists, problems)
        if b:
            runtime.append(b)
    result = {
        'mode': a.mode,
        'source': {'image': 'the packages installed in the image\'s /opt/app-root (backend/requirements.lock)',
                   'frozen': 'the packages the PyInstaller bundle includes (its analysis, mapped to the installed distributions)',
                   'venv': 'the installed backend packages that backend/requirements.lock names (backend/venv)'}[a.mode],
        'packages': packages, 'runtime': runtime, 'problems': problems,
    }
    for p in problems:
        print(f'[licences-python] {"ERROR" if a.strict else "warning"}: {p}', file=sys.stderr)
    if a.strict and problems:
        sys.exit(1)
    if a.merge:
        with open(a.merge, encoding='utf-8') as f:
            doc = json.load(f)
        merge(doc, result)
        with open(a.merge, 'w', encoding='utf-8') as f:
            json.dump(doc, f, separators=(',', ':'))
        print(f'[licences-python] {len(packages)} Python packages and {len(runtime)} runtime entries merged into {a.merge}')
    else:
        json.dump(result, sys.stdout, separators=(',', ':'))


def merge(doc, result):
    """The same shape scripts/generate-licences.mjs writes: the npm entries kept, the Python ones replaced."""
    keep = [p for p in doc['packages'] if p.get('ecosystem') not in ('pypi', 'runtime')]
    rank = {'npm': 0, 'pypi': 1, 'runtime': 2}
    allp = keep + result['packages'] + result['runtime']
    allp.sort(key=lambda p: (rank.get(p['ecosystem'], 9), p['name'].lower(), p['version']))
    doc['packages'] = allp
    doc['generatedFrom']['python'] = result['source']
    doc['counts'] = {'npm': sum(p['ecosystem'] == 'npm' for p in allp), 'pypi': len(result['packages']),
                     'runtime': len(result['runtime']), 'withText': sum(bool(p['texts']) for p in allp)}


if __name__ == '__main__':
    main()
