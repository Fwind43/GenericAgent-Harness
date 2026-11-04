#!/bin/sh
# Packs desktop/stage (from `node desktop/scripts/prepare.mjs`) into a server tarball:
#   server/build.sh <arch> <version>  ->  out/ga-harness-server-<version>-linux-<arch>.tar.gz
set -eu
arch=$1
version=$2
root=$(cd "$(dirname "$0")/.." && pwd -P)
name="ga-harness-server-$version-linux-$arch"
work="$root/out/$name"
rm -rf "$work"
mkdir -p "$work"
cp -a "$root/desktop/stage/python" "$root/desktop/stage/py" "$work/"
cp "$root/server/gah_server.py" "$root/server/gah-server" "$root/server/ga-harness.service" "$work/"
cp "$root/DEPLOY-LINUX.md" "$work/README.md"
chmod 755 "$work/gah-server"
find "$work/py" -name __pycache__ -type d -prune -exec rm -rf {} +
tar -C "$root/out" -czf "$root/out/$name.tar.gz" "$name"
echo "$root/out/$name.tar.gz"
