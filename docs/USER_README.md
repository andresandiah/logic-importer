# Logic Importer (beta, unofficial)

Builds a new LUNA session from a Logic Pro project. **It is not an exact copy.**
Needs a Mac with Apple silicon, LUNA 3.1.2 or later, and a saved Logic project.

1. **Install the helper** (once). In the Add On click "Get the helper installer" and run it.
   If macOS cannot verify it: System Settings > Privacy & Security > Open Anyway. Only do this
   if you downloaded Logic Importer from the project's own GitHub Releases page. Click **Yes**.
2. **Export Logic Metadata.** Choose your .logicx project. It is only read.
3. **Choose an output folder and import.** A new LUNA session is created. Save your work first.
4. **Check the report**, compare by ear, then save the session.

The export folder ("Song for LUNA") can be deleted once the import has finished, the session is
saved and its audio plays.

**Helper location:** `/Library/Application Support/Logic Importer`
(login item: `/Library/LaunchAgents/com.logicimporter.helper.plist`).
**Uninstall:** open that folder and double-click "Uninstall Logic Importer Helper".

Licences are in the `licenses` folder. The LUNA Builder SDK inside this Add On is covered by
Apache 2.0 and Universal Audio's supplemental terms.
