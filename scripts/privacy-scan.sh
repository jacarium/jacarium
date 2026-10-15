#!/bin/bash
# Privacy scan: what would leak if this source were shared?
#
# Runs over exactly what a source tarball holds - the tracked files - and
# reports anything that identifies a person, a customer, an employer, a
# home network or a secret. Exit 1 on any finding (each one masked to its
# first and last characters), 0 when clean. Nothing is written or changed.
#
#   scripts/privacy-scan.sh                       the tracked files, as they are in the working tree (default)
#   scripts/privacy-scan.sh --ref v3.0.2          what `git archive v3.0.2` would publish
#   scripts/privacy-scan.sh --archive out.tar.gz  a tarball that was already produced
#   scripts/privacy-scan.sh --dir <path>          any directory (the self-test uses it)
#
# Options:
#   --denylist <file>   personal terms, one per line (a literal, case-insensitive;
#                       or re:<regex>; # comments). Default: .privacy-denylist.local
#                       in the repo (ignored by git), else
#                       ~/.config/jacarium/privacy-denylist, else none.
#                       The list is searched in every file, binaries included.
#   --no-denylist       generic checks only
#   --max-mb <n>        largest file a tarball may carry (default 1)
#
# What is checked (no personal data lives in this file):
#   email addresses outside example/test/invalid domains; user@<private IP>
#   (a real deploy target); /Users/<name> and /home/<name> paths;
#   0xxxxxxx 8-digit numbers (support-case numbers); <tenant>.atlassian.net
#   other than the documented placeholder; well-known token formats and
#   private keys; PNG text/time/EXIF chunks and JPEG EXIF; SVG editor
#   metadata; WebP EXIF/XMP chunks (metadata is found by content, so a
#   renamed file keeps being checked); raster images anywhere but
#   build/icons/, public/ and the README's screenshots in
#   docs/screenshots/ - WebP files only, by content (a screenshot of a
#   working profile shows real data; those come from scripts/screenshots,
#   synthetic content only); .env/key/certificate/
#   database/log/editor files; files over --max-mb.
#
# tests/privacy-scan.test.mjs runs it over the repository and over a
# throwaway directory with synthetic leaks; scripts/release.cjs runs it
# before tagging a release.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE=tracked; REF=""; ARCHIVE=""; DIR=""; DENYLIST=""; NO_DENYLIST=no; MAX_MB=1
while [ $# -gt 0 ]; do
    case "$1" in
        --tracked) MODE=tracked ;;
        --ref) MODE=ref; REF="$2"; shift ;;
        --archive) MODE=archive; ARCHIVE="$2"; shift ;;
        --dir) MODE=dir; DIR="$2"; shift ;;
        --denylist) DENYLIST="$2"; shift ;;
        --no-denylist) NO_DENYLIST=yes ;;
        --max-mb) MAX_MB="$2"; shift ;;
        -h|--help) sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "privacy-scan: unknown option $1 (see --help)" >&2; exit 2 ;;
    esac
    shift
done

for tool in python3 tar; do
    command -v "$tool" >/dev/null 2>&1 || { echo "privacy-scan: $tool is required" >&2; exit 2; }
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/privacy-scan.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
LIST="$TMP/files.lst"

case "$MODE" in
    tracked)
        command -v git >/dev/null 2>&1 || { echo "privacy-scan: git is required for --tracked" >&2; exit 2; }
        SCAN_ROOT="$ROOT"
        git -C "$ROOT" ls-files -z > "$LIST" || exit 2
        ;;
    ref)
        command -v git >/dev/null 2>&1 || { echo "privacy-scan: git is required for --ref" >&2; exit 2; }
        SCAN_ROOT="$TMP/tree"; mkdir -p "$SCAN_ROOT"
        git -C "$ROOT" archive --format=tar "$REF" | tar -x -C "$SCAN_ROOT" || { echo "privacy-scan: git archive $REF failed" >&2; exit 2; }
        (cd "$SCAN_ROOT" && find . -type f -print0) > "$LIST"
        ;;
    archive)
        [ -f "$ARCHIVE" ] || { echo "privacy-scan: no such archive: $ARCHIVE" >&2; exit 2; }
        SCAN_ROOT="$TMP/tree"; mkdir -p "$SCAN_ROOT"
        tar -xzf "$ARCHIVE" -C "$SCAN_ROOT" || { echo "privacy-scan: cannot extract $ARCHIVE" >&2; exit 2; }
        # a tarball with one top-level folder (git archive --prefix): scan inside it
        entries=( "$SCAN_ROOT"/* )
        if [ ${#entries[@]} -eq 1 ] && [ -d "${entries[0]}" ]; then SCAN_ROOT="${entries[0]}"; fi
        (cd "$SCAN_ROOT" && find . -type f -print0) > "$LIST"
        ;;
    dir)
        [ -d "$DIR" ] || { echo "privacy-scan: no such directory: $DIR" >&2; exit 2; }
        SCAN_ROOT="$(cd "$DIR" && pwd)"
        (cd "$SCAN_ROOT" && find . -type f -not -path './.git/*' -not -path '*/node_modules/*' -print0) > "$LIST"
        ;;
esac

if [ "$NO_DENYLIST" = yes ]; then
    DENYLIST=""
elif [ -z "$DENYLIST" ]; then
    if [ -f "$ROOT/.privacy-denylist.local" ]; then DENYLIST="$ROOT/.privacy-denylist.local"
    elif [ -f "$HOME/.config/jacarium/privacy-denylist" ]; then DENYLIST="$HOME/.config/jacarium/privacy-denylist"
    fi
elif [ ! -f "$DENYLIST" ]; then
    echo "privacy-scan: no such denylist: $DENYLIST" >&2; exit 2
fi

python3 -I - "$SCAN_ROOT" "$LIST" "$DENYLIST" "$MAX_MB" "$MODE" <<'PY'
import os, re, struct, sys

root, list_file, denylist_file, max_mb, mode = sys.argv[1:6]
max_bytes = float(max_mb) * 1024 * 1024
with open(list_file, 'rb') as fh:
    paths = [p.decode('utf-8', 'replace') for p in fh.read().split(b'\0') if p]
paths = [p[2:] if p.startswith('./') else p for p in paths]   # find(1) prefixes ./

findings = []
def found(check, path, line, match):
    findings.append((check, path, line, match))

def mask(s):
    s = str(s)
    if len(s) > 12:
        return s[:4] + '…' + s[-4:]
    if len(s) > 4:
        return s[:2] + '…' + s[-2:]
    return '***'

# ---- generic patterns (text files) ------------------------------------
SAFE_DOMAIN = re.compile(r'^(?:[a-z0-9-]+\.)*(?:example|test|sample|dummy|placeholder|localhost|invalid)(?:\.[a-z0-9-]+)*$', re.I)
# a real address ends in an alphabetic TLD: python@3.14, pi@192.168.0.50 and
# a user:password@<private IP> URL are not e-mail (the private-IP form has its
# own check)
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])')
USER_AT_PRIVATE_IP = re.compile(r'(?<![A-Za-z0-9._-])([A-Za-z0-9._-]+)@(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?!\d)')
GENERIC_USERS = {'pi', 'user', 'root', 'admin', 'you', 'ubuntu', 'core', 'ec2-user', 'fedora', 'debian'}
HOME_PATH = re.compile(r'(?<![A-Za-z0-9])/(?:Users|home)/(?!(?:user|other|username|you|yourname|someone)(?![A-Za-z0-9._-]))([A-Za-z0-9._-]+)')
CASE_NUMBER = re.compile(r'(?<![0-9A-Za-z.#-])(0\d{7})(?![0-9A-Za-z])')   # not #rrggbbaa colours
ATLASSIAN = re.compile(r'https?://([a-z0-9-]+)\.atlassian\.net', re.I)
ATLASSIAN_PLACEHOLDERS = {'your-company', 'your-tenant', 'example', 'yourcompany'}
TOKENS = [
    ('aws access key', re.compile(r'(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])')),
    ('github token', re.compile(r'(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})')),
    ('gitlab token', re.compile(r'(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}')),
    ('slack token', re.compile(r'(?<![A-Za-z0-9])xox[abpr]-[A-Za-z0-9-]{10,}')),
    ('openai/anthropic key', re.compile(r'(?<![A-Za-z0-9])sk-(?:ant-)?[A-Za-z0-9_-]{32,}')),
    ('google api key', re.compile(r'(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}')),
    ('private key', re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----')),
]
SKIP_TEXT_CHECKS = re.compile(r'(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|[^/]+\.min\.js)$')

FORBIDDEN = re.compile(r'(^|/)\.env($|\.)|\.(pem|key|p12|pfx|crt|cer|der|sqlite|sqlite3|db|log|bak|orig|swp|tmp)$'
                       r'|(^|/)\.DS_Store$|(^|/)\.(idea|vscode)/|(^|/)node_modules/|(^|/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|(^|/)known_hosts$|(^|/)\.jacarium\.env$')
RASTER = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tif', '.tiff'}
PNG_META = {b'tEXt', b'iTXt', b'zTXt', b'tIME', b'eXIf'}
SVG_META = re.compile(r'inkscape|sodipodi|<metadata|/Users/|/home/', re.I)

def image_allowed(path):
    if path.startswith('build/icons/'):
        return True
    # The README's screenshots: WebP only (cwebp writes no metadata; the
    # WebP check below reports EXIF/XMP), one level, synthetic content from
    # scripts/screenshots
    if path.startswith('docs/screenshots/') and '/' not in path[len('docs/screenshots/'):] and path.endswith('.webp'):
        return True
    return path.startswith('public/') and '/' not in path[len('public/'):]

# ---- denylist ---------------------------------------------------------
deny = []
if denylist_file:
    with open(denylist_file, 'r', encoding='utf-8', errors='replace') as fh:
        for raw in fh:
            term = raw.strip()
            if not term or term.startswith('#'):
                continue
            if term.startswith('re:'):
                deny.append((term, re.compile(term[3:].encode('utf-8'), re.I)))
            else:
                deny.append((term, re.compile(re.escape(term).encode('utf-8'), re.I)))

n_files = n_images = 0
for path in paths:
    full = os.path.join(root, path)
    if not os.path.isfile(full):
        continue   # deleted in the working tree
    n_files += 1
    size = os.path.getsize(full)
    if FORBIDDEN.search(path):
        found('forbidden file', path, 0, path)
    if size > max_bytes:
        found('size', path, 0, f'{size} bytes > {max_mb} MB')
    with open(full, 'rb') as fh:
        data = fh.read()
    for term, rx in deny:
        if rx.search(path.encode('utf-8')):
            found('denylist (file name)', path, 0, term)
    if deny:
        text_for_lines = None
        for term, rx in deny:
            m = rx.search(data)
            if m:
                line = data[:m.start()].count(b'\n') + 1 if b'\0' not in data[:4096] else 0
                found('denylist', path, line, term)
    ext = os.path.splitext(path)[1].lower()
    if ext in RASTER or ext == '.svg':
        n_images += 1
    is_png = data[:8] == b'\x89PNG\r\n\x1a\n'
    is_jpeg = data[:2] == b'\xff\xd8'
    is_webp = data[:4] == b'RIFF' and data[8:12] == b'WEBP'
    if ext in RASTER and not image_allowed(path):
        found('image location', path, 0, 'raster image outside build/icons/, public/ or docs/screenshots/*.webp (What\'s New ships no screenshots)')
    elif ext == '.webp' and path.startswith('docs/screenshots/') and not is_webp:
        # the allowance is for WebP bytes, not the extension: a renamed PNG or JPEG is still a screenshot
        found('image location', path, 0, 'named .webp but not a WebP file')
    # metadata by content, not by name (a renamed file keeps its metadata)
    if is_png:
        i = 8
        while i + 8 <= len(data):
            ln = struct.unpack('>I', data[i:i+4])[0]; typ = data[i+4:i+8]
            if typ in PNG_META:
                found('png metadata', path, 0, f'{typ.decode("latin1")} chunk ({ln} bytes) - strip it (oxipng --strip all / exiftool -all=)')
            i += 12 + ln
    if is_webp:
        i = 12
        while i + 8 <= len(data):
            typ = data[i:i+4]; ln = struct.unpack('<I', data[i+4:i+8])[0]
            if typ in (b'EXIF', b'XMP '):
                found('webp metadata', path, 0, f'{typ.decode("latin1").strip()} chunk ({ln} bytes) - strip it (cwebp -metadata none / exiftool -all=)')
            i += 8 + ln + (ln & 1)
    if is_jpeg:
        i = 2
        while i + 4 <= len(data) and data[i] == 0xFF:
            marker = data[i+1]; ln = struct.unpack('>H', data[i+2:i+4])[0]
            if marker == 0xE1 and data[i+4:i+8] == b'Exif':
                found('jpeg metadata', path, 0, 'EXIF segment - strip it (exiftool -all=)')
            if marker == 0xDA:
                break
            i += 2 + ln
    if b'\0' in data[:8192]:
        continue   # binary: generic text checks do not apply
    text = data.decode('utf-8', 'replace')
    if ext == '.svg':
        for m in SVG_META.finditer(text):
            found('svg metadata', path, text[:m.start()].count('\n') + 1, m.group(0))
    if SKIP_TEXT_CHECKS.search(path):
        continue
    for lineno, line in enumerate(text.split('\n'), 1):
        for m in EMAIL.finditer(line):
            domain = m.group(0).split('@', 1)[1]
            if not SAFE_DOMAIN.match(domain):
                found('email', path, lineno, mask(m.group(0)))
        for m in USER_AT_PRIVATE_IP.finditer(line):
            if m.group(1).lower() not in GENERIC_USERS:
                found('user@private-ip', path, lineno, mask(m.group(0)))
        for m in HOME_PATH.finditer(line):
            found('home path', path, lineno, mask(m.group(0)))
        for m in CASE_NUMBER.finditer(line):
            if set(m.group(1)) <= {'0', '1'}:
                continue   # binary / all-zero literals
            found('case number', path, lineno, mask(m.group(1)))
        for m in ATLASSIAN.finditer(line):
            if m.group(1).lower() not in ATLASSIAN_PLACEHOLDERS:
                found('atlassian tenant', path, lineno, mask(m.group(0)))
        for name, rx in TOKENS:
            for m in rx.finditer(line):
                found(f'secret ({name})', path, lineno, mask(m.group(0)))

for check, path, line, match in findings:
    where = f'{path}:{line}' if line else path
    print(f'{check:<24} {where}  {match}')
status = 'FAIL' if findings else 'OK'
print(f'privacy-scan: {status} - {mode}: {n_files} files, {n_images} images, {len(findings)} finding(s), denylist: {denylist_file or "none"}')
sys.exit(1 if findings else 0)
PY
