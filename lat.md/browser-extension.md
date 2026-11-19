# Browser extension

At launch the app checks Chrome and Yandex Browser for the corporate extension "RAZUM AI Assistant" and offers to install it where it is missing or turned off.

The app cannot install the extension itself: both browsers accept store installs only from a user click or an admin policy, and RAZUM IT cannot force-install into Yandex Browser. So the app reads browser profile files and, when needed, opens the extension's store page in that browser.

## Detection

[[src/main/browser-extension.ts#detectBrowserExtension]] reads files only and never starts a browser; it checks the last-used profile of each installed browser.

A browser counts as installed when its user-data folder has `Local State`; the profile is `profile.last_used` from it (falling back to `Default`). [[src/main/browser-extension.ts#extensionStatusInProfile]] looks for `extensions.settings.<id>` in `Secure Preferences`, then `Preferences`: an entry with non-empty `disable_reasons` (or legacy `state: 0`) is `disabled`, any other entry is `installed`; with no entry an `Extensions/<id>` folder still counts as installed. Yandex Browser installs Chrome Web Store extensions under the same ID and keeps the same file layout (checked on a real profile, Nov 2026). The agent's own Chrome profile lives in the companion folder and is never looked at.

## Banner and settings

[[src/renderer/src/components/BrowserExtensionBanner.tsx#BrowserExtensionBanner]] shows under the tab strip for every user when a browser lacks the enabled extension.

"Install in …" opens the store page in that browser ([[src/main/browser-extension.ts#openExtensionStore]]: the browser's executable on Windows, `open -a` on macOS; the default browser if neither is found). "Later" snoozes for 7 days, "Don't remind" turns reminders off; Settings → Startup has the toggle to turn them back on. The banner re-checks on window focus (at most once a minute) and daily, so it disappears by itself once the extension is installed. State lives in `browser-extension.json` in the app's user-data folder.
