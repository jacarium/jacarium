"""
Desktop installers served from the home server (accounts mode and the open
browser deployment alike; the desktop's own backend has none).

    GET /api/version                   {app, protocol, name, authMode} - no sign-in needed
    GET /api/downloads/                the downloads page (HTML)
    GET /api/downloads/manifest.json   what is published: {version, files: [...]}
    GET /api/downloads/files/<name>    one installer (attachment)
    GET /api/tls/root.crt              the CA root of the certificate clients see
                                       (PEM, no sign-in): <HOME>/tls/root.crt when the
                                       deploy copied the reverse proxy's root there
                                       (deploy-to-host.sh --proxy-ca-from), else this
                                       server's own self-signed certificate when it
                                       terminates TLS itself, else 404 - the desktop
                                       pins it at link time (electron/tls-trust.cjs)

The installers are NOT in the image: `deploy/deploy-to-host.sh <host>
publish-desktop` copies them to <data volume>/downloads/ together with a
manifest.json ({version, generatedAt, files: [{name, size, sha256,
platform, arch, kind}]}) and only re-sends what changed. Only files named
in the manifest that exist on disk are listed or served; names are a strict
character class, so a path can never leave the directory; there is no
directory listing. Downloads need no sign-in: the deployment is a LAN
service behind the user's own proxy, and an installer is public by nature.
"""
import html
import json
import os
import re

from flask import Blueprint, Response, jsonify, send_file

from version_info import version_info

downloads = Blueprint('downloads', __name__)

SAFE_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._ -]{0,180}$')
MIME = {
    '.dmg': 'application/x-apple-diskimage', '.zip': 'application/zip', '.AppImage': 'application/octet-stream',
    '.deb': 'application/vnd.debian.binary-package', '.exe': 'application/vnd.microsoft.portable-executable',
    '.gz': 'application/gzip',
}


def downloads_dir():
    """<HOME>/downloads - the data volume's downloads directory (not created here)."""
    return os.path.join(os.path.expanduser('~'), 'downloads')


def published():
    """The manifest's files that really exist, with their on-disk size; {} without a manifest."""
    base = downloads_dir()
    try:
        with open(os.path.join(base, 'manifest.json'), 'r', encoding='utf-8') as fh:
            manifest = json.load(fh)
    except (OSError, ValueError):
        return {'version': None, 'generatedAt': None, 'files': []}
    files = []
    for entry in manifest.get('files') or []:
        name = entry.get('name') if isinstance(entry, dict) else None
        if not isinstance(name, str) or not SAFE_NAME.match(name) or '..' in name:
            continue
        path = os.path.join(base, name)
        if not os.path.isfile(path):
            continue
        files.append({
            'name': name,
            'size': os.path.getsize(path),
            'sha256': str(entry.get('sha256') or ''),
            'platform': str(entry.get('platform') or ''),
            'arch': str(entry.get('arch') or ''),
            'kind': str(entry.get('kind') or os.path.splitext(name)[1].lstrip('.')),
            'version': str(entry.get('version') or manifest.get('version') or ''),
            'note': str(entry.get('note') or ''),
        })
    return {'version': manifest.get('version'), 'generatedAt': manifest.get('generatedAt'), 'files': files}


@downloads.route('/api/version', methods=['GET'])
def api_version():
    from extensions import AUTH_MODE
    import central_ticket
    # capabilities a linked desktop checks before showing the administration
    # (an older server without them gets a notice instead of broken tabs),
    # and whether a central server is provided behind this one (its path;
    # the team features of a linked desktop come from it)
    return jsonify({**version_info(), 'authMode': AUTH_MODE, 'capabilities': {'desktopAdmin': True, 'stepUp': True, 'central': central_ticket.capabilities()}})


@downloads.route('/api/tls/root.crt', methods=['GET'])
def tls_root():
    """The root certificate the desktop pins: public data (a certificate), served without sign-in."""
    candidates = [os.path.join(os.path.expanduser('~'), 'tls', 'root.crt')]
    # behind a reverse proxy the certificate clients see is the proxy's, not
    # ours: without a copied root there is nothing true to serve
    if os.environ.get('JACARIUM_BEHIND_PROXY', '').strip() not in ('1', 'true', 'yes'):
        candidates.append(os.environ.get('TLS_CERT_FILE', '').strip())
    for path in candidates:
        if not path or not os.path.isfile(path):
            continue
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                text = fh.read()
        except OSError:
            continue
        if '-----BEGIN CERTIFICATE-----' not in text:
            continue
        return Response(text, mimetype='application/x-pem-file', headers={'Cache-Control': 'no-cache'})
    return jsonify({'error': 'No root certificate is published by this server'}), 404


@downloads.route('/api/downloads/manifest.json', methods=['GET'])
def manifest():
    return jsonify({**published(), 'server': version_info()})


@downloads.route('/api/downloads/files/<name>', methods=['GET'])
def download_file(name):
    if not SAFE_NAME.match(name or '') or '..' in name:
        return jsonify({'error': 'No such file'}), 404
    if not any(f['name'] == name for f in published()['files']):
        return jsonify({'error': 'No such file'}), 404
    path = os.path.join(downloads_dir(), name)
    ext = os.path.splitext(name)[1]
    return send_file(path, as_attachment=True, download_name=name, mimetype=MIME.get(ext, 'application/octet-stream'), conditional=True)


def _human(size):
    for unit in ('B', 'KB', 'MB', 'GB'):
        if size < 1024 or unit == 'GB':
            return f'{size:.0f} {unit}' if unit == 'B' else f'{size:.1f} {unit}'
        size /= 1024.0
    return f'{size:.1f} GB'


@downloads.route('/api/downloads/', methods=['GET'])
@downloads.route('/api/downloads', methods=['GET'])
def page():
    info = version_info()
    pub = published()
    e = html.escape
    installers = [f for f in pub['files'] if f['kind'] != 'source']
    sources = [f for f in pub['files'] if f['kind'] == 'source']
    row = lambda f: (f'<tr><td><a href="/api/downloads/files/{e(f["name"])}" download>{e(f["name"])}</a></td>'
                     f'<td>{e(f["platform"] or "-")}{(" " + e(f["arch"])) if f["arch"] else ""}</td>'
                     f'<td>{e(f["version"] or "-")}</td><td>{_human(f["size"])}</td>'
                     f'<td><code>{e(f["sha256"] or "-")}</code>{("<br><small>" + e(f["note"]) + "</small>") if f["note"] else ""}</td></tr>')
    head = '<thead><tr><th>File</th><th>Platform</th><th>Version</th><th>Size</th><th>SHA-256</th></tr></thead>'
    rows = ''.join(row(f) for f in installers)
    table = (f'<table>{head}<tbody>{rows}</tbody></table>'
             if rows else '<p class="empty">No installers are published on this server yet. On the machine that builds the desktop app: '
                          '<code>deploy/deploy-to-host.sh &lt;user@host&gt; publish-desktop</code> (builds, or takes the existing <code>dist-electron/</code> output, and copies only what changed).</p>')
    source_section = ''
    if sources:
        src = sources[0]
        folder = src['name'][:-len('-src.tar.gz')] if src['name'].endswith('-src.tar.gz') else 'jacarium'
        source_section = (f'<h2 id="source">Source code</h2><table>{head}<tbody>{"".join(row(f) for f in sources)}</tbody></table>'
                          '<p>Build from source on Linux (the AppImages above, when published, were built on macOS without the packaged Python backend; a build on Linux includes it). '
                          'Prerequisites: <strong>podman or docker</strong> for the container build that <code>rebuild.sh</code> uses by default - or, with <code>--no-container</code>, '
                          'Node.js 20+ with npm, Python 3.14 with venv, and the AppImage tooling electron-builder fetches. Then:</p>'
                          f'<pre><code>tar xzf {e(src["name"])}\ncd {e(folder)}\n./rebuild.sh                      # Linux AppImage, built in a container\n./rebuild.sh --format deb         # or a .deb; --help lists the options\n./rebuild.sh --no-container --platform mac   # on a Mac: a dmg</code></pre>'
                          '<p class="muted">The archive is <code>git archive</code> of the release tag: the committed files only, nothing local.</p>')
    mac_note = ('<h2>Opening the macOS build the first time</h2><p>The build is not signed with an Apple developer certificate, so macOS warns the first time. '
                'Open the .dmg, drag Jacarium to Applications, then <strong>right-click (Control-click) the app and choose Open</strong>, and confirm. '
                'If macOS says the app is damaged or cannot be checked, run <code>xattr -dr com.apple.quarantine "/Applications/Jacarium.app"</code> once in Terminal. '
                'Compare the SHA-256 (<code>shasum -a 256 &lt;file&gt;</code>) with the value above.</p>') if any(f['platform'] == 'macOS' for f in pub['files']) else ''
    body = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jacarium - desktop app downloads</title>
<style>
:root{{color-scheme:light dark;--fg:#151515;--muted:#6a6e73;--bg:#f5f5f5;--card:#fff;--border:#d2d2d2;--blue:#0066cc;--accent:#7B5CE0;--hero:#F6F2FF;--hero-fg:#15121F;--hero-muted:#5B4E7A;--blossom:#FFFFFF}}
@media (prefers-color-scheme:dark){{:root{{--fg:#f0f0f0;--muted:#a0a4a8;--bg:#0F0D16;--card:#1f1f1f;--border:#3a3a3a;--blue:#4a9eff;--hero:#17141F;--hero-fg:#F3EFFF;--hero-muted:#B9AFD6;--blossom:#EDE6FF}}}}
@font-face{{font-family:'Sora';font-style:normal;font-weight:600;font-display:swap;src:url(/static/vendor/sora/sora-latin-600-normal.woff2) format('woff2')}}
body{{margin:0;padding:24px 16px;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--fg);background:var(--bg)}}
main{{max-width:960px;margin:0 auto;background:var(--card);border:1px solid var(--border);border-radius:4px;padding:24px}}
.hero{{display:flex;align-items:center;gap:16px;background:var(--hero);border-radius:20px;padding:18px 20px;margin:0 0 18px}}.hero .blossom{{fill:var(--blossom)}}.hero .wordmark{{font-family:'Sora',system-ui,sans-serif;font-weight:600;font-size:28px;letter-spacing:-0.03em;line-height:1;color:var(--hero-fg)}}.hero .tagline{{color:var(--hero-muted);font-size:13px;margin:6px 0 0}}.hero a{{color:var(--accent)}}
h1{{font-size:18px;margin:0 0 4px}}h2{{font-size:14px;margin:24px 0 8px}}p{{margin:8px 0}}.muted{{color:var(--muted)}}
table{{width:100%;border-collapse:collapse;margin-top:12px}}th,td{{text-align:left;padding:8px 10px;border-top:1px solid var(--border);vertical-align:top}}th{{color:var(--muted);font-weight:600;font-size:12px}}
code{{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}}pre{{background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:10px;overflow:auto}}pre code{{word-break:normal}}a{{color:var(--blue)}}.empty{{padding:12px;border:1px dashed var(--border);border-radius:4px}}
</style></head><body><main>
<div class="hero"><svg class="mark" width="52" height="52" viewBox="0 0 120 120" role="img" aria-label="Jacarium"><path d="M22 110 V54 A38 38 0 0 1 98 54 V110 Z" fill="#7B5CE0"/><g class="blossom"><ellipse cx="60" cy="49" rx="8.5" ry="13" transform="rotate(0 60 64)"/><ellipse cx="60" cy="49" rx="8.5" ry="13" transform="rotate(72 60 64)"/><ellipse cx="60" cy="49" rx="8.5" ry="13" transform="rotate(144 60 64)"/><ellipse cx="60" cy="49" rx="8.5" ry="13" transform="rotate(216 60 64)"/><ellipse cx="60" cy="49" rx="8.5" ry="13" transform="rotate(288 60 64)"/></g><circle cx="60" cy="64" r="5" fill="#7B5CE0"/></svg><div><div class="wordmark">Jacarium</div><p class="tagline">{e(info.get('tagline') or '')} &middot; <a href="{e(info.get('homepage') or 'https://jacarium.com')}" target="_blank" rel="noopener noreferrer">jacarium.com</a> (opens in your browser)</p></div></div>
<h1>Desktop app</h1>
<p class="muted">This server runs Jacarium <strong id="server-version">{e(info['app'])}</strong> (protocol {info['protocol']}). The desktop app checks this version when it links and whenever it connects; a desktop of another version shows a notice and links here, so you can download the matching version from your home server.</p>
{table}
{mac_note}
{source_section}
<h2>Linking the desktop app</h2><p>In the desktop app: Settings &gt; General &gt; Home server, enter this server's address, your username and password once. The profile then synchronises with your account like a browser does.</p>
<p class="muted"><a href="/">Back to Jacarium</a></p>
</main></body></html>"""
    return Response(body, mimetype='text/html')
