#!/bin/sh
# Build the self-contained helper and its macOS installer (Apple silicon).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
py="$here/.venv/bin/python"
work="$here/build/installer"
rm -rf "$work"; mkdir -p "$work/dist" "$work/root/Library/LaunchAgents" "$work/root/Library/Application Support/Logic Importer/licenses"

# Optional Apple signing (needs a Developer account; see docs/SIGNING.md). Unset: unsigned.
app_id="${SIGN_APP_IDENTITY:-}"
pkg_id="${SIGN_INSTALLER_IDENTITY:-}"
notary="${NOTARY_PROFILE:-}"
set --
[ -n "$app_id" ] && set -- --codesign-identity "$app_id" --osx-entitlements-file "$here/installer/entitlements.plist"

# 1. The Audio Unit settings reader. Prefix maps keep this machine's paths out of the binary.
swiftc -O -target arm64-apple-macos12 -file-prefix-map "$here=." "$here/converter/austate.swift" -o "$work/austate"

# 2. Python, the converter and logicxkit in one folder: the user needs nothing else.
PYTHONPATH="$here/.deps/logicxkit/src" "$py" -m PyInstaller --noconfirm --clean --onedir --console \
  "$@" --name logic-importer-helper --distpath "$work/dist" --workpath "$work/work" --specpath "$work" \
  --paths "$here/converter" --paths "$here/.deps/logicxkit/src" \
  --hidden-import convert --hidden-import helper \
  --collect-all logicxkit --collect-all pw_foundation --collect-all groovebin \
  --add-binary "$work/austate:." "$here/converter/app.py" > "$work/pyinstaller.log" 2>&1

dest="$work/root/Library/Application Support/Logic Importer"
cp -R "$work/dist/logic-importer-helper" "$dest/"
# Compiled caches and install records can name the build machine's folders.
find "$dest" -name 'direct_url.json' -delete
find "$dest" -name 'RECORD' -path '*.dist-info/*' -delete
cp "$here/installer/Uninstall Logic Importer Helper.command" "$dest/"
cp "$here/installer/com.logicimporter.helper.plist" "$work/root/Library/LaunchAgents/"

# 3. Licences of what is bundled.
cp "$here/.deps/logicxkit/LICENSE" "$dest/licenses/logicxkit-LICENSE.txt"
cp "$here/.deps/logicxkit/NOTICE" "$dest/licenses/logicxkit-NOTICE.txt"
for d in "$here"/.venv/lib/python*/site-packages/*.dist-info; do
  n="$(basename "$d" .dist-info)"
  case "$n" in pip-*) continue;; esac
  find "$d" -type f \( -iname 'LICENSE*' -o -iname 'NOTICE*' -o -iname 'COPYING*' \) | while read -r f; do cp "$f" "$dest/licenses/$n-$(basename "$f")"; done
done
pylib="$("$py" -c 'import sysconfig;print(sysconfig.get_path("stdlib"))')"
[ -f "$pylib/LICENSE.txt" ] && cp "$pylib/LICENSE.txt" "$dest/licenses/Python-LICENSE.txt"

# 4. The installer package. Not relocatable: files must land where the login item expects them.
pkgbuild --analyze --root "$work/root" "$work/components.plist" >/dev/null
i=0
while /usr/libexec/PlistBuddy -c "Set :$i:BundleIsRelocatable false" "$work/components.plist" 2>/dev/null; do i=$((i+1)); done
pkgbuild --root "$work/root" --component-plist "$work/components.plist" --scripts "$here/installer/scripts" \
  --identifier com.logicimporter.helper --version 0.2.0 --install-location / --ownership recommended "$work/component.pkg" >/dev/null
mkdir -p "$here/add-on/helper-installer"
set --
[ -n "$pkg_id" ] && set -- --sign "$pkg_id"
productbuild "$@" --distribution "$here/installer/distribution.xml" --resources "$here/installer/resources" \
  --package-path "$work" "$here/add-on/helper-installer/Logic Importer Helper.pkg" >/dev/null
out="$here/add-on/helper-installer/Logic Importer Helper.pkg"
if [ -n "$notary" ]; then
  [ -n "$app_id" ] && [ -n "$pkg_id" ] || { echo "Notarizing needs both signing identities." >&2; exit 1; }
  xcrun notarytool submit "$out" --keychain-profile "$notary" --wait
  xcrun stapler staple "$out"
fi
ls -lh "$here/add-on/helper-installer/"
