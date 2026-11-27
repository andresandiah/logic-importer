# Signing and notarizing the installer

Optional for uploading, but without it users must click "Open Anyway". It needs a paid Apple
Developer Program membership. **This path has not been run yet**; test the result carefully,
including that third-party Audio Units still load in the hardened runtime.

1. In the Apple Developer account create two certificates and add them to your keychain:
   **Developer ID Application** and **Developer ID Installer**.
2. Store notary credentials once (the tool prompts for them; never put them in this repository):

       xcrun notarytool store-credentials logic-importer-notary

3. Build with your identities (list them with `security find-identity -v`):

       export SIGN_APP_IDENTITY="Developer ID Application: …"
       export SIGN_INSTALLER_IDENTITY="Developer ID Installer: …"
       export NOTARY_PROFILE=logic-importer-notary
       ./release.sh

4. Check: `spctl --assess --type install -v "add-on/helper-installer/Logic Importer Helper.pkg"`

A signed binary contains your developer name and team ID. That is expected and public.
