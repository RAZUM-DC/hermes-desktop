# Main Process

The Electron main process keeps the entrypoint small and separates app lifecycle from IPC registration.

## Entrypoint

`src/main/index.ts` performs only pre-ready setup and delegates startup.

[[src/main/index.ts]] applies GPU crash preferences, enables the optional CDP testing port, and calls [[src/main/app/start.ts#startMainProcess]]. This keeps one-off process boot concerns separate from windows, menus, updater wiring, and IPC.

## GPU Fallback

Hardware acceleration is disabled and persisted after a GPU-process crash so machines without a usable GPU (VMs, virtual display adapters) avoid an infinite crash → relaunch loop.

[[src/main/gpu-fallback.ts#applyGpuPreferences]] disables hardware acceleration when a crash flag, relaunch sentinel, or `HERMES_DISABLE_GPU` says so, while keeping SwiftShader WebGL available. Persistent GPU-off fallback is honored by default on Windows/Linux, but macOS clears stale flags unless `HERMES_GPU_FALLBACK=1` forces it, protecting the Office tab from permanent software-rendering lag. [[src/main/gpu-fallback.ts#installGpuCrashGuard]] watches fatal GPU-process exits and relaunches with software rendering where the persistent fallback is enabled.

## App Lifecycle

Lifecycle code owns Electron windows, global app events, and shutdown cleanup.

[[src/main/app/start.ts#startMainProcess]] registers crash logging, IPC handlers, updater handlers, Electron ready/activate/window-all-closed/before-quit events, CSP headers, security hardening, and the main BrowserWindow.

[[src/main/app/start.ts]] also supports the `HERMES_OPEN_DEVTOOLS=1` diagnostic launch path so packaged builds can expose renderer console errors when startup fails before the UI paints.

The packaged renderer keeps its meta CSP aligned with the production response CSP so file-backed startup assets load consistently from `file://` before the main-process header can help.

Because electron-vite emits a bundled main file at `out/main/index.js`, packaged renderer loading resolves `../renderer/index.html` from `__dirname` to reach `out/renderer/index.html`.

## App Chrome Helpers

Menu, updater, and context-menu behavior live in focused modules.

[[src/main/app/menu.ts#buildMenu]] owns the application menu, [[src/main/app/updater.ts#setupUpdater]] owns update IPC and electron-updater events, and [[src/main/app/context-menu.ts#showChatContextMenu]] owns the chat right-click menu.

Release builds keep a Help-menu Developer Tools toggle as a production diagnostics escape hatch without changing renderer sandbox or Node isolation.

## Deep Links

The `razum-assistant://session/<id>` link opens one Hermes session and does nothing else.

[[src/main/deep-link.ts#parseDeepLink]] whitelists host `session` and an id of `[A-Za-z0-9_-]{1,128}`; [[src/main/deep-link.ts#pickDeepLinkFromArgv]] extracts it from Windows/Linux argv and `second-instance`, macOS uses `open-url`. [[src/main/deep-link.ts#createDeepLinkDispatcher]] buffers the latest link until the renderer's Layout subscribes via `deep-link:renderer-ready`, then sends `deep-link:open-session` with the bare id. See `docs/deep-link.md`.

## IPC Registry

Renderer IPC handlers are isolated from app bootstrap so the registry can be split by domain.

[[src/main/ipc/register.ts#registerIpcHandlers]] currently preserves the existing handler behavior behind one registration function. It receives app-level callbacks for the main window, model-library notifications, connection-config notifications, external URL opening, and active chat abort handles.

Wallet and token-balance handlers sit in the same registry: `list-wallets`, `create-wallet`, `import-wallet`, `rename-wallet`, `delete-wallet` (backed by [[wallet-token-balances#Wallet Store]]) and `get-token-balances` (backed by [[wallet-token-balances#Token Balances]]).

## Voice transcription IPC

Speech-to-text IPC sends recorded desktop audio through the Hermes API server, not through the active chat model endpoint.

[[src/main/ipc/register.ts#registerIpcHandlers]] exposes `transcribe-audio` for the preload bridge, and [[src/main/hermes.ts#transcribeAudio]] posts a base64 data URL to `/api/audio/transcribe`. If the local gateway lacks that desktop route, it falls back to the Python `tools.transcription_tools.transcribe_audio` dispatcher, so local Whisper, Groq, OpenAI, ElevenLabs, and command/plugin STT providers remain independent from the selected chat model.
