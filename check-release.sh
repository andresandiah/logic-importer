#!/bin/sh
# Refuse to release a package that carries a helper key, this machine's paths or user files.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$here/dist/Logic-Importer.lunaaddon"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unzip -q "$pkg" -d "$tmp/addon"
pkgutil --expand-full "$tmp/addon/add-on/helper-installer/Logic Importer Helper.pkg" "$tmp/installer"
bad=0
grep -q 'window.LOGIC_IMPORTER_HELPER = null;' "$tmp/addon/add-on/helper-config.js" || { echo "A helper key is in the package"; bad=1; }
if grep -rIl -e "$HOME" -e "/Users/$(id -un)" "$tmp" >/dev/null 2>&1 || grep -rl "/Users/$(id -un)/" "$tmp" >/dev/null 2>&1; then
  echo "This machine's home folder path is in the package:"; grep -rl "/Users/$(id -un)" "$tmp" | sed "s#$tmp/##" | head; bad=1
fi
if find "$tmp" \( -name '*.logicx' -o -name '*.lunaimport.json' -o -name '*import report*' -o -name '.env' -o -name '*.wav' -o -name '*.aif' \) | grep -q .; then
  echo "User files are in the package"; bad=1
fi
[ "$bad" = 0 ] && echo "Release check passed." || exit 1
