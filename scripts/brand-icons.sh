#!/bin/bash
# Render every icon the build needs from the committed brand sources in
# public/brand/ (icon.svg, icon-small.svg, mark.svg, mark-light.svg).
#
# Usage:
#   scripts/brand-icons.sh            write build/icons/*, public/icon.*, public/favicon.svg
#   scripts/brand-icons.sh --check    render into a temp dir and compare with the committed files
#
# Output: build/icons/{16,32,48,64,128,256,512,1024}x<n>.png (sizes up to 48
# from icon-small.svg, the arch alone), build/icons/icon.icns (macOS, via
# iconutil), build/icons/icon.ico (Windows: PNG entries 16/32/48/256),
# public/icon.png (512, the Linux window icon), public/favicon.svg and
# public/favicon.png (48), public/apple-touch-icon.png (180) and
# public/icon-{192,512}.png for the web manifest (iPhone "Add to Home
# Screen"), public/favicon.ico (the same ICO as build/icons/icon.ico, for
# the browsers that ask for /favicon.ico regardless), public/icon.svg (a
# copy of the source). Needs rsvg-convert (librsvg;
# brew install librsvg) and, for the .icns, macOS iconutil - without it the
# .icns is left as it is. The PNGs carry no text/time chunks (the privacy scan
# checks that), so the result is reproducible byte for byte.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; }
CHECK=false
case "${1:-}" in
    -h|--help) usage; exit 0 ;;
    --check) CHECK=true ;;
    "") ;;
    *) log_error "unknown option: $1"; usage; exit 1 ;;
esac
need_cmd rsvg-convert "brew install librsvg (or your distribution's librsvg package)"
need_cmd node

SRC="$REPO_ROOT/public/brand"
OUT="$REPO_ROOT"
if [ "$CHECK" = true ]; then OUT="$(mktemp -d)"; mkdir -p "$OUT/build/icons" "$OUT/public"; fi
ICONS="$OUT/build/icons"
mkdir -p "$ICONS"

render() {   # $1 size, $2 destination
    local src="$SRC/icon.svg"
    [ "$1" -le 48 ] && src="$SRC/icon-small.svg"
    rsvg-convert -w "$1" -h "$1" "$src" -o "$2"
}
for s in 16 32 48 64 128 256 512 1024; do render "$s" "$ICONS/${s}x${s}.png"; done
render 512 "$OUT/public/icon.png"
render 48 "$OUT/public/favicon.png"
render 180 "$OUT/public/apple-touch-icon.png"
render 192 "$OUT/public/icon-192.png"
render 512 "$OUT/public/icon-512.png"
cp "$SRC/icon.svg" "$OUT/public/icon.svg"
cp "$SRC/icon-small.svg" "$OUT/public/favicon.svg"

# Windows .ico: a directory of PNG entries (Vista+ reads PNG-compressed icons)
node - "$ICONS" <<'EOF'
const fs = require('fs'); const path = require('path');
const dir = process.argv[2];
const sizes = [16, 32, 48, 256];
const pngs = sizes.map((s) => fs.readFileSync(path.join(dir, `${s}x${s}.png`)));
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
const entries = []; let offset = 6 + 16 * sizes.length;
sizes.forEach((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0); e.writeUInt8(s >= 256 ? 0 : s, 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += pngs[i].length; entries.push(e);
});
fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]));
fs.writeFileSync(path.join(dir, '..', '..', 'public', 'favicon.ico'), Buffer.concat([header, ...entries, ...pngs]));
EOF

# macOS .icns through an iconset (iconutil is macOS only)
if command -v iconutil >/dev/null 2>&1; then
    set_dir="$(mktemp -d)/Jacarium.iconset"; mkdir -p "$set_dir"
    for s in 16 32 128 256 512; do
        cp "$ICONS/${s}x${s}.png" "$set_dir/icon_${s}x${s}.png"
        cp "$ICONS/$((s * 2))x$((s * 2)).png" "$set_dir/icon_${s}x${s}@2x.png"
    done
    iconutil -c icns "$set_dir" -o "$ICONS/icon.icns"
    rm -rf "$(dirname "$set_dir")"
else
    log_warning "iconutil not available - build/icons/icon.icns left as it is"
fi

if [ "$CHECK" = true ]; then
    rc=0
    for f in build/icons/16x16.png build/icons/32x32.png build/icons/48x48.png build/icons/64x64.png build/icons/128x128.png build/icons/256x256.png build/icons/512x512.png build/icons/1024x1024.png build/icons/icon.ico public/icon.png public/icon.svg public/favicon.svg public/favicon.ico public/favicon.png public/apple-touch-icon.png public/icon-192.png public/icon-512.png; do
        if ! cmp -s "$OUT/$f" "$REPO_ROOT/$f"; then log_error "$f differs from the rendered source"; rc=1; fi
    done
    rm -rf "$OUT"
    [ "$rc" = 0 ] && log_success "the committed icons match public/brand/*.svg"
    exit "$rc"
fi
log_success "icons rendered: build/icons/ (png, ico$(command -v iconutil >/dev/null 2>&1 && echo ', icns')), public/icon.png, public/icon.svg, public/favicon.svg"
