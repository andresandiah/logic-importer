# Logic Importer 0.3.0 (beta)

**New:** track colors are imported as close matches of Logic's palette, on tracks, buses and
folders in Logic's track list. Tested only against a mock LUNA so far. The helper has no code
changes: if you already installed it, you do not need to install it again.

Unofficial. Builds a new LUNA session from a Logic Pro project. **Not an exact copy.**

**Download `Logic-Importer.lunaaddon`** and open it in LUNA, then follow the four steps.
Requires Apple silicon and LUNA 3.1.2 or later. The helper installer is included.

**This build's installer is not signed or notarized.** macOS will block it at first
(System Settings > Privacy & Security > Open Anyway).

Not yet verified: the installer, the new screen inside LUNA, the macOS pickers, saving to a
chosen folder and a second Mac. Track colors, MIDI, automation, sends and the mute, solo, send and
bypass checks are tested only against a mock LUNA. See the README for all known limits.

Please do not attach project exports or reports to issues without removing private names.
