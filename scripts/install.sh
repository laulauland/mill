#!/usr/bin/env bash
# mill installer — fetches the latest release binary from GitHub.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/laulauland/mill/main/scripts/install.sh | bash
#
# Env vars:
#   MILL_INSTALL_DIR   target directory for the binary (default: $HOME/.local/bin)
#   MILL_VERSION       pin a specific version, e.g. v0.1.9 (default: latest)

set -euo pipefail

REPO="laulauland/mill"
INSTALL_DIR="${MILL_INSTALL_DIR:-$HOME/.local/bin}"

uname_s=$(uname -s)
uname_m=$(uname -m)

case "$uname_s/$uname_m" in
  Darwin/arm64) bottle_tag="arm64_sequoia" ;;
  Linux/x86_64) bottle_tag="x86_64_linux" ;;
  *)
    echo "mill: unsupported platform $uname_s/$uname_m" >&2
    echo "  build from source: https://github.com/${REPO}#from-source" >&2
    exit 1
    ;;
esac

if [ -n "${MILL_VERSION:-}" ]; then
  tag="${MILL_VERSION#v}"
  tag="v${tag}"
else
  tag=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep -m1 '"tag_name"' \
    | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
fi

if [ -z "${tag:-}" ]; then
  echo "mill: failed to resolve release tag" >&2
  exit 1
fi

version="${tag#v}"
asset="mill-${version}.${bottle_tag}.bottle.tar.gz"
url="https://github.com/${REPO}/releases/download/${tag}/${asset}"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

echo "mill: downloading ${tag} for ${uname_s}/${uname_m}"
curl -fsSL "$url" | tar -xz -C "$tmpdir"

src="$tmpdir/mill/${version}/bin/mill"
if [ ! -x "$src" ]; then
  echo "mill: archive missing expected binary at mill/${version}/bin/mill" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
install -m 755 "$src" "$INSTALL_DIR/mill"

echo "mill ${tag} installed to ${INSTALL_DIR}/mill"

case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo
    echo "note: ${INSTALL_DIR} is not on your PATH."
    echo "      add this to your shell rc:"
    echo "        export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac
