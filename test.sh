#!/bin/sh
# All automated tests. Run ./setup.sh first. Needs no LUNA.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
[ -f "$here/add-on/helper-installer/Logic Importer Helper.pkg" ] || "$here/build-installer.sh"
(cd "$here/add-on" && npm test)
(cd "$here/converter" && PYTHONPATH="$here/.deps/logicxkit/src:." "$here/.venv/bin/python" -B -W ignore -m unittest test_helper)
