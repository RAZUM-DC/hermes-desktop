# Release Packaging

Release publication requires every artifact for the explicitly selected platforms. macOS experiments use a separate manual workflow that cannot publish a production update.

## Complete release artifacts

Linux AppImages include their architecture to prevent x64 and arm64 files overwriting each other. Publication always waits for Linux and Windows, and also for signed macOS when selected.

`scripts/prepare-release-artifacts.mjs` rejects missing or empty installers and update feeds, creates `latest-mac.yml` from both ZIPs with SHA-512 hashes only when macOS is selected, and returns an explicit publication allowlist. Linux ARM64 uses `latest-linux-arm64.yml`.

`Release` is manual-only, defaults to `dry_run=true` and `include_macos=false`, and never publishes on merge. A dry run builds and validates even when the version tag exists, without creating a tag or release. Real releases require the `release` branch.

## Optional production macOS

Windows and Linux ship together without waiting for Apple credentials. macOS is explicitly selected with `include_macos=true`; both signed and notarized architectures must then succeed or publication stops.

The publish job overrides Actions' implicit success condition so a deliberately skipped macOS job does not skip Windows/Linux publication. It still rejects failed, cancelled or skipped required jobs. The artifact mode is explicit, never inferred from files.

With macOS disabled, no macOS installers, blockmaps or `latest-mac.yml` enter the publication allowlist, even if stale files exist. Previously installed macOS clients may report a missing update feed on a newer Windows/Linux-only release; this is not a separate macOS update channel.

Existing version tags are immutable to this workflow. Enabling macOS later requires a new version; it never silently adds macOS to an already published release. Test macOS builds remain isolated from this production choice.

## Publication boundary

Release runs are serialized without cancelling an in-flight publication. A GitHub Release remains a draft until every selected uploaded asset matches its local filename, size and SHA-256 digest.

Missing, extra, corrupt or incomplete uploads fail closed. Only a verified draft is made public. If staging fails after tag creation, the tag and any draft are retained for manual inspection; the existing-tag gate prevents an automatic retry from changing a public release.

## Test macOS builds

The `macOS Test Build (not notarized)` workflow builds x64 and arm64 without Apple credentials and keeps only expiring Actions artifacts. It has read-only repository permissions and no release step.

It runs manually or on packaging-related pull requests to `main` and `release`. The PR trigger permits testing before the new workflow exists on the default branch, without requiring a merge.

The PR job enables `CSC_FOR_PULL_REQUEST` because electron-builder otherwise skips even ad-hoc signing. The test profile fixes the identity to `-` and no signing secrets are supplied.

`electron-builder.macos-test.yml` inherits the main profile but uses a test bundle ID, product name, output directory and artifact names. Ad-hoc signing supports Apple Silicon without Developer ID; notarization is disabled and `publish: null` removes the update feed.

The native-module check discovers the actual `.app` bundle instead of assuming a historical product name. Test builds also verify the ad-hoc signature and absence of `app-update.yml`. A different app name does not isolate the shared Hermes engine home.

## Signing credentials

macOS release jobs consume `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD`, mapped to electron-builder's `CSC_*` variables. Existing Windows `CSC_LINK` and `CSC_KEY_PASSWORD` secrets map to `WIN_CSC_*` variables.

Apple notarization still requires `ASC_API_KEY` (base64 App Store Connect API key), `ASC_KEY_ID` and `ASC_ISSUER_ID`. The test workflow needs none of these. No certificate, token or secret belongs in source control.

## Regression checks

`tests/release-artifacts.test.ts` covers complete artifacts, missing or empty files, architecture collisions, macOS metadata hashes, selected platform sets, publication ordering, dry-run behavior and the test workflow's safety boundaries.

`tests/release-publication.test.ts` checks the workflow gate across job outcomes, intentional macOS skipping, existing-tag dry runs, and draft upload failures before public promotion.

`tests/macos-native-arch.test.ts` exercises bundle discovery and the native-check script with tool fixtures, including lipo argument ordering, architecture mismatches, invalid signatures and forbidden test-app update feeds.

Run `npm test -- tests/release-artifacts.test.ts` for focused checks. Real packaging and launch verification require the corresponding operating system; fixture tests do not establish macOS Gatekeeper acceptance.

CI also verifies the complete preload-to-main IPC contract, including voice-overlay handlers, and exact remote title-update payloads for both manual (`user`) and generated (`auto`) titles.
