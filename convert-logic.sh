#!/bin/sh
# Developer tool: convert a Logic project from Terminal. The project is only read.
# usage: ./convert-logic.sh "/path/to/Song.logicx" [--out "/folder"]
here="$(cd "$(dirname "$0")" && pwd)"
PYTHONPATH="$here/.deps/logicxkit/src" exec "$here/.venv/bin/python" "$here/converter/convert.py" "$@"
