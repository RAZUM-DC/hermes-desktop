# Mac companion

On macOS the app ships the same Go companion and local connectors as on Windows; without them there is no sign-in, no agent shim and no local tools.

## Companion in the Mac bundle

`electron-builder.yml` copies `resources/bin/mac-${arch}` (darwin builds of `companion`, `tool-connector`, `cdp-connector`) into `Contents/Resources/bin`, where [[src/main/companion.ts#startCompanion]] looks for `companion`.

The binaries are cross-compiled from the companion repo and `razum-hermes` (`GOOS=darwin`, `CGO_ENABLED=0`, arm64 and amd64) and committed with a `SHA256SUMS` per architecture, like the Windows set in `resources/bin/win`. `resources/bin/**` is excluded from `files`, so no platform carries the others' binaries inside `app.asar.unpacked`. The macOS test build checks each binary's architecture and signature (`scripts/verify-macos-native-arch.sh`); electron-builder's signing pass signs them along with the app.

On macOS the companion keeps the device secret in the login Keychain (via `/usr/bin/security`, secret never in process arguments); if the Keychain is unavailable it falls back to a 0600 file.

## Menu bar icon

macOS gets a monochrome template image (`resources/trayTemplate.png`, 18 pt with an @2x variant) instead of the 1024 px app icon, which stretched the status item across the menu bar.

[[src/main/app/start.ts#macTrayImage]] builds the image with both scale factors and marks it as a template so the system tints it for light and dark menu bars. Other platforms keep the colour app icon.

## Limits of unsigned builds

Without an Apple Developer ID the Mac build is ad-hoc signed and not notarized.

Gatekeeper warns on first launch; testers open it via right-click → Open or remove the quarantine attribute. Auto-update does not work on macOS for such builds (Squirrel.Mac requires a Developer ID signature), and folder-access prompts may repeat after each new build because the ad-hoc identity changes.
