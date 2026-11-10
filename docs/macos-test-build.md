# macOS test builds

Use **macOS Test Build (not notarized)** in GitHub Actions. This is separate
from the signed `Release` workflow. It needs no Apple Developer
membership or signing secrets and produces x64 (Intel) and arm64 (Apple Silicon)
DMG/ZIP artifacts retained for 14 days. It does not create tags or GitHub Releases.

The workflow also runs automatically on pull requests targeting `main` or
`release` when macOS packaging configuration, the dependency manifest/lockfile,
the architecture-check script, or this workflow changes. This allows a new
workflow to be validated on a draft PR without merging or publishing a release.
The workflow explicitly permits ad-hoc signing on PRs (`CSC_FOR_PULL_REQUEST`);
the test profile still forces identity `-` and does not receive signing secrets.

After the workflow is on the repository's default branch, choose **Actions →
macOS Test Build (not notarized) → Run workflow**, select the desired branch and
download the matching `mac-test-unnotarized-x64` or `mac-test-unnotarized-arm64`
artifact. GitHub normally only lists manual workflows that exist on the default
branch. Preparing this patch does not start a build.

## Build locally on a Mac

From a clean checkout, use Node.js 22 and run:

```sh
npm ci
# Select arm64 for Apple Silicon, x64 for Intel:
npx electron-builder install-app-deps --arch=arm64
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder \
  --config electron-builder.macos-test.yml --mac dmg zip --arm64 --publish never
MACOS_TEST_BUILD=true bash scripts/verify-macos-native-arch.sh arm64 dist/macos-test
```

Artifacts are in `dist/macos-test`, with `test-unnotarized` in their names. The app
is named **РАЗУМ Ассистент Test**, uses a distinct bundle ID, has an ad-hoc
signature, and has no production auto-update feed. It is **not Developer ID
signed or notarized**. Do not distribute it as a normal production release.

## First launch and test data

macOS may block an app downloaded without notarization. Verify that the artifact
came from your own expected commit. If appropriate, permit this specific app in
**System Settings → Privacy & Security → Open Anyway**. Do not disable Gatekeeper
globally. An ad-hoc signature is not a guarantee of download acceptance.

The different app name does **not** isolate the shared `~/.hermes` engine data.
For an isolated smoke test, launch the executable directly with separate paths:

```sh
HERMES_HOME="$HOME/.hermes-macos-test" \
HERMES_DESKTOP_USER_DATA_DIR="$HOME/Library/Application Support/hermes-desktop-test" \
  "/Applications/РАЗУМ Ассистент Test.app/Contents/MacOS/РАЗУМ Ассистент Test"
```

Use disposable test accounts/connections. Check launch, chat, attachments and
microphone access on the target Mac. Packaging checks validate the native module
architecture, ad-hoc signature and missing updater feed, not those interactive flows.

## Later: production macOS releases

A production build requires Apple Developer Program membership, a **Developer ID
Application** certificate/private key exported as `.p12`, its password, and an
App Store Connect API key with notarization access.

- `MAC_CSC_LINK`: macOS `.p12` certificate, normally base64.
- `MAC_CSC_KEY_PASSWORD`: its password.
- `ASC_API_KEY`: base64 contents of the App Store Connect `.p8` key.
- `ASC_KEY_ID` and `ASC_ISSUER_ID`: the matching Apple identifiers.

Keep the existing Windows `CSC_LINK` and `CSC_KEY_PASSWORD` secrets as they are.
The workflow maps them to `WIN_CSC_*`, while Apple uses separate `MAC_CSC_*`
secrets. No secrets are created or changed by this patch.

The signed `Release` workflow now waits for **all** platforms and verifies the
complete artifact set before tagging. Missing Apple credentials therefore block
a production release instead of silently publishing only Windows. Use the test
workflow while Apple signing is not configured. `Release` with `dry_run=true`
tests the full signed pipeline, including artifact validation, without publishing.
