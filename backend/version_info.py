"""
The app's version and the compatibility protocol, from the repository's two
sources of truth: package.json (the app version, bumped by every release)
and protocol.json (the protocol the desktop app and the home server must
share - synchronisation, sign-in / device tokens, the account identity).

Both files live next to the backend: ../package.json in a checkout and in
the container (deploy/Containerfile copies them to /app/); the desktop's
packaged backend carries them as PyInstaller data files
(backend/flask-backend.spec). Without them it answers "unknown".
"""
import json
import os
import platform
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_cache = None


def _read_json(name):
    # a checkout / the container: next to the backend directory; the frozen
    # desktop backend: PyInstaller unpacks its data files under _MEIPASS
    bases = [os.path.dirname(_HERE), _HERE, os.getcwd()]
    if getattr(sys, '_MEIPASS', None):
        bases.insert(0, sys._MEIPASS)
    for base in bases:
        path = os.path.join(base, name)
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                return json.load(fh)
        except (OSError, ValueError):
            continue
    return None


_VERSION_STRING = re.compile(r'^\d+\.\d+(\.\d+)?([a-z0-9.+-]{0,20})?$')


def _runtimes():
    """The runtimes this server runs on, as version strings only (Settings > About): the Python
    that runs the backend (read live) and, in the container, the Node.js the central server runs
    on - recorded by the image build (deploy/Containerfile writes `node --version` to
    /app/node-version next to this file's parent) rather than probed at runtime. Nothing about
    the host, the user or any path; a value that is not a version string is left out."""
    out = {'python': platform.python_version()}
    for base in [os.path.dirname(_HERE), _HERE]:
        try:
            with open(os.path.join(base, 'node-version'), 'r', encoding='utf-8') as fh:
                node = fh.read().strip().lstrip('v')
        except OSError:
            continue
        if _VERSION_STRING.match(node):
            out['node'] = node
        break
    return out


def version_info():
    """{'app': 'X.Y.Z' | 'unknown', 'protocol': int, 'name': 'Jacarium', 'tagline': str, 'homepage': str,
    'runtimes': {'python': str, 'node'?: str}}."""
    global _cache
    if _cache is None:
        pkg = _read_json('package.json') or {}
        proto = _read_json('protocol.json') or {}
        try:
            protocol = int(proto.get('protocol'))
        except (TypeError, ValueError):
            protocol = 1
        _cache = {
            'app': str(pkg.get('version') or 'unknown'),
            'protocol': protocol,
            'name': 'Jacarium',
            # the brand's words come from package.json (the UI reads the same file)
            'tagline': str(pkg.get('description') or ''),
            'homepage': str(pkg.get('homepage') or ''),
            'runtimes': _runtimes(),
        }
    return {**_cache, 'runtimes': dict(_cache['runtimes'])}
