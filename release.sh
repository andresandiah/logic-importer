#!/bin/sh
# Build everything for a GitHub release: installer, tests, packaged Add On, privacy check.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
"$here/build-installer.sh"
"$here/test.sh"
"$here/pack-addon.sh"
"$here/check-release.sh"
