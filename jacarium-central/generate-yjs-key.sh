#!/bin/bash

#
# Generate an encryption key for Yjs document persistence
#
# The central server encrypts persisted collaborative-document snapshots
# (data/documents/*.ydoc) with AES-256-GCM. The key comes from the
# YJS_STORAGE_ENCRYPTION_KEY environment variable and must be exactly
# 64 hexadecimal characters (32 bytes / 256 bits).
#
# Without the variable set, the server runs in memory-only mode: documents
# do NOT survive idle eviction or a restart (and are never written to disk
# unencrypted). See yjs-persistence.js for details.
#
# NOTE: ./deploy-podman.sh generates and reuses its own key automatically
# (see ~/.config/jacarium/central/keys/yjs-encryption.key,
# or $YJS_KEY_DIR if overridden) - you only need this script for a
# manual/local run via ./run.sh, or to inspect/rotate the key by hand.
#
# Usage:
#   ./generate-yjs-key.sh
#
# Then start the server with the key, e.g.:
#   YJS_STORAGE_ENCRYPTION_KEY=<key> ./run.sh
#
# IMPORTANT: keep the key stable. Changing or losing it makes every
# previously persisted snapshot undecryptable (the server will log an error
# and fall back to empty documents for those).
#

set -euo pipefail

case "${1:-}" in -h|--help) sed -n '3,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac

KEY="$(openssl rand -hex 32)"

echo ""
echo "Generated YJS_STORAGE_ENCRYPTION_KEY:"
echo ""
echo "  ${KEY}"
echo ""
echo "Start the server with:"
echo ""
echo "  YJS_STORAGE_ENCRYPTION_KEY=${KEY} node server.js"
echo ""
echo "Store this key somewhere safe - snapshots encrypted with it cannot be"
echo "recovered without it."
echo ""
