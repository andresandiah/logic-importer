# Publishing on GitHub

1. Review Universal Audio's supplemental terms for the SDK bundled in the release. They state no
   clear rule for distributing Add Ons. If unsure, ask Universal Audio or a lawyer first.
2. Optionally put your name or organisation in NOTICE, and "manufacturer" in
   add-on/manifest.json. Both become public.
3. Create an empty public repository. Git records your name and email in every commit; to keep
   your email private, use the "noreply" address from GitHub's email settings.
4. From this folder: `git init`, `git add .`, then **read `git status`** before committing.
5. Push. Do not add anything under dist/ to the repository.
6. Create a release tagged `v0.2.0`, titled "0.2.0 (beta)". Paste docs/RELEASE_NOTES.md.
   Attach `dist/Logic-Importer.lunaaddon` and its `.sha256`. Attach no other `.lunaaddon`:
   LUNA's docs say a repository address installs every one in the latest release.
   LUNA's docs speak of the "latest release". GitHub does not treat a release marked
   "pre-release" as latest, so leaving that box unticked may be needed for installing by address.
7. Download the attached file again and compare its checksum.
