#!/usr/bin/env python3
"""
Guards the server's version endpoint and the desktop downloads
(backend/version_info.py, backend/downloads.py):
  - GET /api/tls/root.crt (the CA root the desktop pins) needs no sign-in: 404
    without a file, the PEM once <data>/tls/root.crt exists;
  - GET /api/version needs no sign-in and reports the app version from
    package.json and the protocol from protocol.json (one source of truth);
    /api/capabilities carries the same two values
  - /api/downloads/ without published installers says so (no sign-in),
    lists nothing, and offers no directory listing
  - with a manifest + files on the data volume it lists each file with
    platform, version, size and SHA-256, links to it, shows the macOS
    first-open note, and the file downloads as an attachment with the right
    content type; a manifest entry whose file is missing is hidden; a name
    not in the manifest, a traversal and an unsafe name are 404
Run: backend/venv/bin/python tests/version_and_downloads.test.py
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BACKEND = os.path.join(ROOT, 'backend')
TMP = tempfile.mkdtemp(prefix='jacarium-downloads-')
HOME = os.path.join(TMP, 'data')
os.makedirs(HOME)
os.environ['HOME'] = HOME
os.environ['JACARIUM_AUTH_MODE'] = 'accounts'
os.environ['JACARIUM_REPORTS_ROOT'] = os.path.join(HOME, 'reports')
os.environ['JACARIUM_KNOWN_HOSTS'] = os.path.join(HOME, '.ssh', 'known_hosts')
os.environ.pop('JACARIUM_ENV_FILE', None)
sys.path.insert(0, BACKEND)
os.chdir(BACKEND)
import app as app_module  # noqa: E402

BASE = 'https://console.test'
results = []


def check(name, passed, detail=''):
    results.append((name, bool(passed)))
    print(f"{'PASS' if passed else 'FAIL'} - {name}{f' ({detail})' if detail else ''}")


c = app_module.app.test_client()
pkg = json.load(open(os.path.join(ROOT, 'package.json')))
proto = json.load(open(os.path.join(ROOT, 'protocol.json')))

r = c.get('/api/version', base_url=BASE)
v = r.get_json() or {}
check('/api/version answers without a sign-in', r.status_code == 200, str(r.status_code))
check('...with the app version from package.json', v.get('app') == pkg['version'], f"{v.get('app')} vs {pkg['version']}")
check('...and the protocol from protocol.json', v.get('protocol') == proto['protocol'] and isinstance(v.get('protocol'), int), str(v.get('protocol')))
check('...and the auth mode', v.get('authMode') == 'accounts')
caps = c.get('/api/capabilities', base_url=BASE).get_json()
check('/api/capabilities carries the same version and protocol', caps.get('version') == pkg['version'] and caps.get('protocol') == proto['protocol'])

# --- the CA root the desktop pins (public, no sign-in; backend/downloads.py tls_root) ---
r = c.get('/api/tls/root.crt', base_url=BASE)
check('/api/tls/root.crt answers 404 without a certificate to serve (no sign-in gate: 404, not 401)', r.status_code == 404, str(r.status_code))
os.makedirs(os.path.join(HOME, 'tls'), exist_ok=True)
with open(os.path.join(HOME, 'tls', 'root.crt'), 'w') as fh:
    fh.write('-----BEGIN CERTIFICATE-----\nc3ludGhldGljIHJvb3Q=\n-----END CERTIFICATE-----\n')
r = c.get('/api/tls/root.crt', base_url=BASE)
check('...serves <data>/tls/root.crt as PEM without a sign-in once it exists', r.status_code == 200 and r.mimetype == 'application/x-pem-file' and b'c3ludGhldGlj' in r.data, f"{r.status_code} {r.mimetype}")
os.remove(os.path.join(HOME, 'tls', 'root.crt'))

# --- nothing published ---
r = c.get('/api/downloads/', base_url=BASE)
page = r.get_data(as_text=True)
check('the downloads page is served without a sign-in', r.status_code == 200 and r.mimetype == 'text/html')
check('...says no installers are published and how to publish', 'No installers are published' in page and 'publish-desktop' in page)
check('...and names the server version', pkg['version'] in page)
check('...no macOS note without a macOS file', 'Opening the macOS build' not in page)
r = c.get('/api/downloads/manifest.json', base_url=BASE)
check('the manifest is empty', r.status_code == 200 and r.get_json()['files'] == [] and r.get_json()['server']['app'] == pkg['version'])
check('a file request with nothing published is 404', c.get('/api/downloads/files/x.dmg', base_url=BASE).status_code == 404)

# --- published ---
dl = os.path.join(HOME, 'downloads')
os.makedirs(dl)
payload = b'synthetic installer bytes ' * 100
open(os.path.join(dl, 'Jacarium-9.9.9-arm64.dmg'), 'wb').write(payload)
open(os.path.join(dl, 'Jacarium-9.9.9-arm64.AppImage'), 'wb').write(b'linux ' * 10)
open(os.path.join(dl, 'jacarium-9.9.9-src.tar.gz'), 'wb').write(b'\x1f\x8b' + b'synthetic archive' * 20)
open(os.path.join(dl, 'manifest.json'), 'w').write(json.dumps({'version': '9.9.9', 'generatedAt': '2026-10-12T00:00:00Z', 'files': [
    {'name': 'Jacarium-9.9.9-arm64.dmg', 'size': 1, 'sha256': 'ab' * 32, 'platform': 'macOS', 'arch': 'arm64', 'kind': 'dmg', 'version': '9.9.9'},
    {'name': 'Jacarium-9.9.9-arm64.AppImage', 'size': 1, 'sha256': 'cd' * 32, 'platform': 'Linux', 'arch': 'arm64', 'kind': 'AppImage', 'version': '9.9.9', 'note': 'without the packaged Python backend'},
    {'name': 'Jacarium-9.9.9-x64.AppImage', 'size': 1, 'sha256': 'ef' * 32, 'platform': 'Linux', 'arch': 'x64', 'kind': 'AppImage'},
    {'name': 'jacarium-9.9.9-src.tar.gz', 'size': 1, 'sha256': '12' * 32, 'platform': 'Source', 'arch': '', 'kind': 'source', 'version': '9.9.9'},
    {'name': '../accounts.sqlite', 'size': 1, 'sha256': '00' * 32, 'platform': 'x', 'arch': '', 'kind': 'dmg'},
]}))
m = c.get('/api/downloads/manifest.json', base_url=BASE).get_json()
names = [f['name'] for f in m['files']]
check('the manifest lists the files that exist, with their real size', names == ['Jacarium-9.9.9-arm64.dmg', 'Jacarium-9.9.9-arm64.AppImage', 'jacarium-9.9.9-src.tar.gz'] and m['files'][0]['size'] == len(payload), str(names))
check('...an entry whose file is missing, and an unsafe name, are hidden', 'Jacarium-9.9.9-x64.AppImage' not in names and not any('..' in n for n in names))
page = c.get('/api/downloads/', base_url=BASE).get_data(as_text=True)
check('the page lists platform, version, size and SHA-256 with a download link', 'macOS arm64' in page and '9.9.9' in page and ('%s' % ('ab' * 32)) in page and 'href="/api/downloads/files/Jacarium-9.9.9-arm64.dmg"' in page and '2.5 KB' in page, page[page.find('<table'):page.find('<table') + 300])
check('...shows the Linux note and the macOS first-open note', 'without the packaged Python backend' in page and 'Opening the macOS build' in page and 'xattr' in page)
src_at = page.find('id="source"')
check('the Source code section lists the archive with version, size and SHA-256 and a download link', src_at > 0 and 'jacarium-9.9.9-src.tar.gz' in page[src_at:] and ('%s' % ('12' * 32)) in page[src_at:] and 'href="/api/downloads/files/jacarium-9.9.9-src.tar.gz"' in page[src_at:])
check('...with the Linux build steps and prerequisites', 'tar xzf jacarium-9.9.9-src.tar.gz' in page and 'cd jacarium-9.9.9' in page and './rebuild.sh' in page and 'podman or docker' in page and 'Python 3.14' in page and 'Node.js' in page)
check('...the source archive is not in the installers table', page.find('jacarium-9.9.9-src.tar.gz') > page.find('<table') and page[page.find('<table'):src_at].count('src.tar.gz') == 0)
r = c.get('/api/downloads/files/jacarium-9.9.9-src.tar.gz', base_url=BASE)
check('the source archive downloads as a gzip attachment', r.status_code == 200 and r.mimetype == 'application/gzip' and 'attachment' in r.headers.get('Content-Disposition', ''))
r = c.get('/api/downloads/files/Jacarium-9.9.9-arm64.dmg', base_url=BASE)
check('the installer downloads as an attachment with its content type', r.status_code == 200 and r.data == payload and 'attachment' in r.headers.get('Content-Disposition', '') and 'Jacarium-9.9.9-arm64.dmg' in r.headers.get('Content-Disposition', '') and r.mimetype == 'application/x-apple-diskimage', f"{r.status_code} {r.headers.get('Content-Disposition')} {r.mimetype}")
check('a file not in the manifest is 404 even if it exists', (open(os.path.join(dl, 'stray.dmg'), 'wb').write(b'x') or True) and c.get('/api/downloads/files/stray.dmg', base_url=BASE).status_code == 404)
check('a missing manifest entry file is 404', c.get('/api/downloads/files/Jacarium-9.9.9-x64.AppImage', base_url=BASE).status_code == 404)
for bad in ['..%2Faccounts.sqlite', '%2e%2e/accounts.sqlite', 'a%00.dmg', 'manifest.json']:
    r = c.get(f'/api/downloads/files/{bad}', base_url=BASE)
    check(f'traversal / unsafe name refused: {bad}', r.status_code == 404, str(r.status_code))
check('/api/downloads (no slash) serves the page too', c.get('/api/downloads', base_url=BASE).status_code in (200, 308))
check('no directory listing', c.get('/api/downloads/files/', base_url=BASE).status_code == 404)

failed = [n for n, ok in results if not ok]
print()
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
sys.exit(1 if failed else 0)
