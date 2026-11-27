#!/bin/sh
# One-time developer setup. Everything stays inside this folder. End users do not need this.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

# Pinned third-party code. Change these deliberately and re-test.
LOGICXKIT_REPO="https://github.com/phierceweb/logicxkit.git"
LOGICXKIT_COMMIT="d2af8566da27e89fe6cd271c656b8d8625374759"
# The LUNA Builder SDK commit is pinned in add-on/package.json.

fail() { echo "setup: $1" >&2; exit 1; }
[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] || fail "a Mac with Apple silicon is required."
command -v git >/dev/null || fail "git is missing."
command -v swiftc >/dev/null || fail "Swift is missing. Run: xcode-select --install"
command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || fail "Node.js 22 or newer is required."
python3 -c 'import sys; sys.exit(sys.version_info < (3, 12))' || fail "Python 3.12 or newer is required."

echo "By continuing you download the LUNA Builder SDK. Universal Audio states that downloading or"
echo "using it means accepting Apache 2.0 and its supplemental terms:"
echo "https://github.com/uaudio-labs/luna-builder-sdk/blob/main/SUPPLEMENTAL-TERMS.md"
if [ "${ACCEPT_UA_TERMS:-}" != "yes" ]; then
  printf "Type yes to accept and continue: "; read answer
  [ "$answer" = "yes" ] || fail "stopped; nothing was downloaded."
fi

echo "== logicxkit at $LOGICXKIT_COMMIT"
if [ ! -d .deps/logicxkit/.git ]; then
  mkdir -p .deps/logicxkit
  git -C .deps/logicxkit init -q
  git -C .deps/logicxkit remote add origin "$LOGICXKIT_REPO"
  # Only the code and the one sample the tests use: the full repository is over 300 MB.
  git -C .deps/logicxkit sparse-checkout set src tests/corpus/stack-11-summing-resave.logicx
fi
git -C .deps/logicxkit fetch -q --depth 1 --filter=blob:none origin "$LOGICXKIT_COMMIT"
git -C .deps/logicxkit checkout -q "$LOGICXKIT_COMMIT"

echo "== Python packages"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q --disable-pip-version-check -r requirements-build.txt

echo "== Add On packages (builds the LUNA SDK)"
if [ -f add-on/package-lock.json ]; then (cd add-on && npm ci --no-fund --no-audit)
else (cd add-on && npm install --no-fund --no-audit); fi
# npm may record the SDK as an SSH address, which fails for people without a GitHub SSH key.
[ -f add-on/package-lock.json ] && sed -i '' 's#git+ssh://git@github.com/#git+https://github.com/#g' add-on/package-lock.json
mkdir -p add-on/vendor
cp add-on/node_modules/@uaudio/luna-builder-sdk/dist/luna.global.js add-on/vendor/

[ -f add-on/helper-config.js ] || printf '// The helper fills this in on this Mac after it is installed.\nwindow.LOGIC_IMPORTER_HELPER = null;\n' > add-on/helper-config.js
echo "Setup complete. Next: ./test.sh, then ./release.sh"
