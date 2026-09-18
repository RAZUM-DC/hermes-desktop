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

## IPC Registry

Renderer IPC handlers are isolated from app bootstrap so the registry can be split by domain.

[[src/main/ipc/register.ts#registerIpcHandlers]] currently preserves the existing handler behavior behind one registration function. It receives app-level callbacks for the main window, model-library notifications, connection-config notifications, external URL opening, and active chat abort handles.

Wallet and token-balance handlers sit in the same registry: `list-wallets`, `create-wallet`, `import-wallet`, `rename-wallet`, `delete-wallet` (backed by [[wallet-token-balances#Wallet Store]]) and `get-token-balances` (backed by [[wallet-token-balances#Token Balances]]).

## Voice transcription IPC

Speech-to-text IPC sends recorded desktop audio through the Hermes API server, not through the active chat model endpoint.

[[src/main/ipc/register.ts#registerIpcHandlers]] exposes `transcribe-audio` for the preload bridge, and [[src/main/hermes.ts#transcribeAudio]] posts a base64 data URL to `/api/audio/transcribe`. If the local gateway lacks that desktop route, it falls back to the Python `tools.transcription_tools.transcribe_audio` dispatcher, so local Whisper, Groq, OpenAI, ElevenLabs, and command/plugin STT providers remain independent from the selected chat model.

## SSH credential persistence

Every RAZUM Desktop SSH `.env` update runs as a remote locked transaction, so overlapping provider and messaging writes preserve unrelated credentials.

[[src/main/ssh-remote.ts#sshSetEnvValue]] sends all mutations through [[src/main/ssh-env-update.ts#REMOTE_ENV_UPDATE_SCRIPT]]. The remote helper locks a stable sibling `.env.lock`, reads the latest file only after acquiring the lock, and replaces it atomically through a same-directory temporary file.

Paths, keys, and values travel as JSON on standard input rather than credential-bearing shell arguments. Existing line endings, unrelated lines, ownership, permissions, ACLs, extended attributes, security labels, and symlink targets are preserved. A new `.env` is created with mode `0600`; unsafe metadata or filesystem failures abort the replacement.

This lock coordinates Desktop writers across processes and connections. Manual tools and Hermes Agent do not use the Desktop lock, so they should not edit the same `.env` concurrently with a Desktop save.

### Concurrent writers

Independent Desktop updates wait for the same remote lock and each read the newest committed file before modifying one key.

### Profile routing and secret transport

The default and named profiles resolve to separate `.env` paths, while every secret stays in the SSH process's standard input and out of its command arguments.

### Failure preservation

Read, validation, fsync, metadata, and replacement failures leave the original credential file unchanged, clean temporary files, and propagate an error to the caller.
