#!/bin/sh
# Removes the Logic Importer helper. The LUNA Add On, your sessions and Logic projects stay.
echo "This removes the Logic Importer helper from this Mac."
printf "Type yes to continue: "
read answer
[ "$answer" = "yes" ] || { echo "Nothing was removed."; exit 0; }
launchctl bootout "gui/$(id -u)/com.logicimporter.helper" 2>/dev/null
# macOS asks for an administrator password.
osascript -e 'do shell script "rm -f /Library/LaunchAgents/com.logicimporter.helper.plist && rm -rf \"/Library/Application Support/Logic Importer\" && (pkgutil --forget com.logicimporter.helper || true)" with administrator privileges' || { echo "Not removed."; exit 1; }
rm -rf "$HOME/Library/Application Support/Logic Importer"
echo "The helper was removed. You can close this window."
