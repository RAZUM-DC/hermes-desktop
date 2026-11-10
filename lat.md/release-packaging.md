# Release Packaging

Release publication requires a complete set of platform artifacts. macOS experiments use a separate manual workflow that cannot publish a production update.

## Complete release artifacts

Linux AppImages include their architecture to prevent x64 and arm64 files overwriting each other. Publication waits for macOS, Linux and Windows before validating every required file and creating a tag.

`scripts/prepare-release-artifacts.mjs` rejects missing or empty installers and update feeds, creates `latest-mac.yml` from both ZIPs with SHA-512 hashes, and returns an explicit publication allowlist. Linux ARM64 uses `latest-linux-arm64.yml`.

`Release` with `dry_run=true` builds and validates even when the version tag exists, but neither creates a tag nor publishes. The ordinary macOS path remains Developer ID signed and notarized; Windows retains its existing signing setup.

## Test macOS builds

The `macOS Test Build (not notarized)` workflow builds x64 and arm64 without Apple credentials and keeps only expiring Actions artifacts. It has read-only repository permissions and no release step.

It runs manually or on packaging-related pull requests to `main` and `release`. The PR trigger permits testing before the new workflow exists on the default branch, without requiring a merge.

`electron-builder.macos-test.yml` inherits the main profile but uses a test bundle ID, product name, output directory and artifact names. Ad-hoc signing supports Apple Silicon without Developer ID; notarization is disabled and `publish: null` removes the update feed.

The native-module check discovers the actual `.app` bundle instead of assuming a historical product name. Test builds also verify the ad-hoc signature and absence of `app-update.yml`. A different app name does not isolate the shared Hermes engine home.

## Signing credentials

macOS release jobs consume `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD`, mapped to electron-builder's `CSC_*` variables. Existing Windows `CSC_LINK` and `CSC_KEY_PASSWORD` secrets map to `WIN_CSC_*` variables.

Apple notarization still requires `ASC_API_KEY` (base64 App Store Connect API key), `ASC_KEY_ID` and `ASC_ISSUER_ID`. The test workflow needs none of these. No certificate, token or secret belongs in source control.

## Regression checks

`tests/release-artifacts.test.ts` covers complete artifacts, every missing or empty required file, architecture collisions, macOS metadata hashes, publication ordering, dry-run behavior and the test workflow's safety boundaries.

Run `npm test -- tests/release-artifacts.test.ts` for focused checks. Real packaging and launch verification require the corresponding operating system; fixture tests do not establish macOS Gatekeeper acceptance.
