# Mac companion

On macOS the app ships the same Go companion and local connectors as on Windows; without them there is no sign-in, no agent shim and no local tools.

## Companion in the Mac bundle

`electron-builder.yml` copies `resources/bin/mac-${arch}` (darwin builds of `companion`, `tool-connector`, `cdp-connector`) into `Contents/Resources/bin`, where [[src/main/companion.ts#startCompanion]] looks for `companion`.

The binaries are cross-compiled from the companion repo and `razum-hermes` (`GOOS=darwin`, `CGO_ENABLED=0`, arm64 and amd64) and committed with a `SHA256SUMS` per architecture, like the Windows set in `resources/bin/win`. `resources/bin/**` is excluded from `files`, so no platform carries the others' binaries inside `app.asar.unpacked`. The macOS test build checks each binary's architecture and signature (`scripts/verify-macos-native-arch.sh`); electron-builder's signing pass signs them along with the app.

On macOS the companion keeps the device secret in the login Keychain (via `/usr/bin/security`, secret never in process arguments); if the Keychain is unavailable it falls back to a 0600 file.

## Companion lifecycle

Outside Windows there is no Job Object, so the companion manages its own lifetime: it replaces a hung predecessor and exits when the app that started it is gone.

On a busy single-instance port the companion probes the previous instance's agent shim; if it does not answer within 3 s and the pid in `companion.pid` is a `companion`, it sends CONT, TERM and finally KILL, then takes the port. It watches its parent pid and stops (with its connectors) when the app disappears, writes its log to `companion.log` in its data directory, and never blocks on a stderr pipe nobody reads. The app restarts a companion that crashed ([[src/main/companion.ts#companionRestartDelay]]: 2 s → 60 s, gives up after repeated crashes in 10 minutes); exit code 0 means another instance already serves and is not restarted.

## Menu bar icon

macOS gets a monochrome template image (`resources/trayTemplate.png`, 18 pt with an @2x variant) instead of the 1024 px app icon, which stretched the status item across the menu bar.

[[src/main/app/start.ts#macTrayImage]] builds the image with both scale factors and marks it as a template so the system tints it for light and dark menu bars. Other platforms keep the colour app icon.

## Limits of unsigned builds

Without an Apple Developer ID the Mac build is ad-hoc signed and not notarized.

Gatekeeper warns on first launch; testers open it via right-click → Open or remove the quarantine attribute. Auto-update does not work on macOS for such builds (Squirrel.Mac requires a Developer ID signature), and folder-access prompts may repeat after each new build because the ad-hoc identity changes.
