#!/bin/sh
# Build www/downloads/sync-browsers.zip from extension/ for the site's Download section.
# Leaves out config.local.js (personal dev config with the sync passphrase).
set -eu
cd "$(dirname "$0")/.."
out=www/downloads/sync-browsers.zip
mkdir -p www/downloads
rm -f "$out"
(cd extension && zip -qr "../$out" manifest.json background.js lib popup pages icons -x '*.local.js' 'icons/README.md')
if unzip -l "$out" | grep -q 'local\.js'; then echo "ERROR: local config in zip" >&2; rm -f "$out"; exit 1; fi
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' extension/manifest.json)
echo "Built $out (extension $version, $(wc -c < "$out") bytes)"
