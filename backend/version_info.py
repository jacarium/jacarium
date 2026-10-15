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


def version_info():
    """{'app': 'X.Y.Z' | 'unknown', 'protocol': int, 'name': 'Jacarium', 'tagline': str, 'homepage': str}."""
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
        }
    return dict(_cache)
