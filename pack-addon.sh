#!/bin/sh
# Package the Add On into dist/, with licences and a blank helper-config.js (never a real key).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
sdk="$here/add-on/node_modules/@uaudio/luna-builder-sdk"
cd "$here/add-on"

rm -rf licenses && mkdir licenses
cp "$here/LICENSE" licenses/LogicImporter-LICENSE.txt
cp "$here/NOTICE" licenses/LogicImporter-NOTICE.txt
cp "$here/THIRD_PARTY_NOTICES.md" licenses/
for f in LICENSE NOTICE SUPPLEMENTAL-TERMS.md; do cp "$sdk/$f" "licenses/LunaBuilderSDK-$f"; done
cp "$here/docs/USER_README.md" README.md

# A developer's own key is set aside while packing and put back afterwards.
hold="$(mktemp -d)"
cp helper-config.js "$hold/"
trap 'cp "$hold/helper-config.js" "$here/add-on/helper-config.js"; rm -rf "$hold"' EXIT
printf '// The helper fills this in on this Mac after it is installed.\nwindow.LOGIC_IMPORTER_HELPER = null;\n' > helper-config.js

"$sdk/dist/cli.js" pack . 2>/dev/null || node "$sdk/dist/cli.js" pack .
mkdir -p "$here/dist"
mv add-on.lunaaddon "$here/dist/Logic-Importer.lunaaddon"
(cd "$here/dist" && shasum -a 256 Logic-Importer.lunaaddon > Logic-Importer.lunaaddon.sha256)
echo "dist/Logic-Importer.lunaaddon"
