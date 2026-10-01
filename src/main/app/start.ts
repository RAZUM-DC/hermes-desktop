import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
} from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import icon from "../../../resources/icon.png?asset";
import { getPublicConnectionConfig } from "../config";
import { stopHealthPolling } from "../hermes";
import { stopAllDashboards } from "../dashboard";
import { cleanupTempMediaFiles } from "../media";
import { closeDbConnection } from "../db";
import {
  hardenAttachedWebContents,
  hardenWebviewPreferences,
  isAllowedAppNavigationUrl,
  isAllowedExternalUrl,
  isAllowedWebviewUrl,
} from "../security";
import { registerIpcHandlers } from "../ipc/register";
import { setGatewayPromptParent } from "../gatewayPrompt";
import { showChatContextMenu } from "./context-menu";
import { buildMenu } from "./menu";
import { attachWindowHotkeys } from "./window-hotkeys";
import { initAutostartDefault, shouldStartHidden } from "../autostart";
import { setupUpdater } from "./updater";
import { startCompanion, stopCompanion } from "../companion";
import { warmVoiceDaemon, stopVoiceDaemon } from "../voice-sidecar";
import { destroyVoiceDictation, setupVoiceDictation } from "./voice-overlay";
import { startStaffWatcher, stopStaffWatcher } from "../staff-watcher";

const APP_NAME =
  process.env.HERMES_DESKTOP_APP_NAME?.trim() || "РАЗУМ Ассистент";
const OPEN_DEVTOOLS_ON_START =
  process.env.HERMES_OPEN_DEVTOOLS === "1" ||
  process.env.HERMES_DESKTOP_OPEN_DEVTOOLS === "1";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
/**
 * Старт из автозагрузки: окно не показываем, приложение ждёт в трее.
 *
 * Считается один раз здесь, а не при каждом обращении: после того как человек
 * сам открыл окно, аргумент командной строки уже ничего не значит, и повторная
 * проверка прятала бы окно там, где его просили показать.
 */
const startHidden = shouldStartHidden(process.argv);
const QUICK_CALL_SHORTCUT =
  process.env.HERMES_DESKTOP_HOTKEY?.trim() || "Control+Shift+Space";
const activeRuns = new Map<string, () => void>();

export function startMainProcess(): void {
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  process.on("uncaughtException", (err) => {
    console.error("[MAIN UNCAUGHT]", err);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[MAIN UNHANDLED REJECTION]", reason);
  });

  registerIpcHandlers({
    activeRuns,
    getMainWindow: () => mainWindow,
    notifyConnectionConfigChanged,
    notifyModelLibraryChanged,
    openExternalUrl,
  });

  setupUpdater({ getMainWindow: () => mainWindow });

  app.whenReady().then(() => {
    electronApp.setAppUserModelId("com.hermes.desktop");

    // Голосовой ввод: разрешаем доступ к микрофону (Electron по умолчанию
    // отклоняет media-запросы из рендерера → "Microphone access denied").
    session.defaultSession.setPermissionRequestHandler(
      (_wc, permission, callback) => {
        callback(permission === "media");
      },
    );
    session.defaultSession.setPermissionCheckHandler(
      (_wc, permission) => permission === "media",
    );

    // Hybrid: запускаем локальный companion (enroll, шимы, tool-connector).
    // Передаём доступ к mainWindow, чтобы in-app OAuth-окно открывалось как
    // дочернее (parent) при state=enrolling.
    startCompanion(() => mainWindow);
    // Резидентный сайдкар распознавания речи: модель грузится один раз здесь,
    // а не при каждой записи. Для кнопки в чате это просто приятно, для
    // диктовки по горячей клавише — обязательно: там ожидание пришлось бы на
    // момент, когда человек уже договорил. Best-effort, старт не блокирует.
    warmVoiceDaemon();

    app.on("browser-window-created", (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    app.on("web-contents-created", (_event, contents) => {
      if (contents.getType() === "webview") {
        // The web preview webview is the only one allowed to load remote HTTPS.
        // Identify it reliably by its session: a <webview partition="web-preview">
        // shares the singleton in-memory session returned by fromPartition().
        // The partition session is the only dependable signal available in
        // web-contents-created — without it, post-attach redirects/navigations
        // (e.g. google.com -> www.google.com) are wrongly blocked.
        const isWebPreview =
          contents.session === session.fromPartition("web-preview");
        hardenAttachedWebContents(contents, isWebPreview);
      }
    });

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; " +
              "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
              "style-src 'self' 'unsafe-inline'; " +
              "img-src 'self' data: blob: file: https:; " +
              "media-src 'self' data: blob: file: https:; " +
              "connect-src 'self' blob: http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* https: wss:; " +
              "font-src 'self' data:; " +
              "frame-src 'self' https: http://127.0.0.1:* http://localhost:*; " +
              "object-src 'none'; " +
              "base-uri 'self';",
          ],
        },
      });
    });

    createWindow();
    buildMenu({ getMainWindow: () => mainWindow, openExternalUrl });
    createTray();
    // Автозапуск включается сам при первом запуске: приложение резидентное, и
    // искать для этого галочку человек не должен. Дальше решает он — отметка
    // о первом запуске не даёт нам вернуть снятую галочку.
    initAutostartDefault();
    // Фоновые уведомления по доске «ИИ-сотрудники» (Фаза B).
    startStaffWatcher(() => mainWindow);
    registerQuickCallShortcut();
    setupVoiceDictation({
      showMainWindow,
      getMainWindow: () => mainWindow,
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    tray?.destroy();
    tray = null;
    stopCompanion();
    stopVoiceDaemon();
    destroyVoiceDictation();
    stopStaffWatcher();
    stopHealthPolling();
    for (const abort of activeRuns.values()) abort();
    activeRuns.clear();
    cleanupTempMediaFiles();
    stopAllDashboards();
    closeDbConnection();
  });
}

function notifyConnectionConfigChanged(): void {
  mainWindow?.webContents.send(
    "connection-config-changed",
    getPublicConnectionConfig(),
  );
}

function notifyModelLibraryChanged(): void {
  mainWindow?.webContents.send("model-library-changed");
}

function openExternalUrl(rawUrl: unknown): void {
  if (!isAllowedExternalUrl(rawUrl)) {
    console.warn("[SECURITY] Blocked unsafe external URL");
    return;
  }
  shell.openExternal(rawUrl).catch((err) => {
    console.error("[SECURITY] Failed to open external URL:", err);
  });
}

function showMainWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(icon);
    tray = new Tray(img.isEmpty() ? icon : img);
  } catch {
    tray = new Tray(icon);
  }
  tray.setToolTip(APP_NAME);
  const menu = Menu.buildFromTemplate([
    { label: "Открыть " + APP_NAME, click: () => showMainWindow() },
    { type: "separator" },
    {
      label: "Выход",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => {
    if (mainWindow?.isVisible() && !mainWindow.isMinimized()) mainWindow.hide();
    else showMainWindow();
  });
}

function registerQuickCallShortcut(): void {
  try {
    const ok = globalShortcut.register(QUICK_CALL_SHORTCUT, () =>
      showMainWindow(),
    );
    if (!ok) console.warn("[HOTKEY] Failed to register", QUICK_CALL_SHORTCUT);
  } catch (err) {
    console.warn("[HOTKEY] register error", err);
  }
}

function createWindow(): void {
  const rendererHtmlPath = join(__dirname, "../renderer/index.html");
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 850,
    minWidth: 900,
    title: APP_NAME,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined,
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    // Явная иконка окна для всех платформ, кроме macOS (там её даёт бандл).
    // На Windows панель задач обычно берёт иконку из ресурсов самого .exe, но
    // прошить их может только rcedit под Windows/wine — на Linux-сборщике этот
    // шаг отключён, и без явной иконки окно получает логотип Electron.
    ...(process.platform === "darwin" ? {} : { icon }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: true,
    },
  });

  attachWindowHotkeys(mainWindow);

  mainWindow.on("ready-to-show", () => {
    // При скрытом старте окно остаётся незагруженным ровно до первого
    // показа — это и нужно: companion, горячие клавиши и наблюдатель доски
    // поднимаются отдельно от окна и работают без него.
    if (!startHidden) mainWindow?.show();
  });
  // Свернуть в трей вместо выхода: окно живёт в трее, quick-call хоткей
  // мгновенно его возвращает. Реальный выход — через меню трея / before-quit.
  mainWindow.on("close", (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.webContents.once("did-finish-load", () => {
    if (OPEN_DEVTOOLS_ON_START) {
      mainWindow?.webContents.openDevTools({ mode: "detach" });
    }
  });

  // Let mid-turn gateway sudo/secret prompts parent their modal to this window.
  setGatewayPromptParent(() => mainWindow);

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(
      "[CRASH] Renderer process gone:",
      details.reason,
      details.exitCode,
    );
  });
  mainWindow.webContents.on("console-message", (details) => {
    // Electron ≥35 passes a single event object (level is now a string);
    // the old positional `(event, level, message, line, sourceId)` signature
    // is deprecated.
    if (details.level === "error") {
      console.error(
        `[RENDERER ERROR] ${details.message} (${details.sourceId}:${details.lineNumber})`,
      );
    }
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription) => {
      console.error("[LOAD FAIL]", errorCode, errorDescription);
    },
  );
  mainWindow.webContents.setWindowOpenHandler((details) => {
    openExternalUrl(details.url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (
      isAllowedAppNavigationUrl(
        url,
        rendererHtmlPath,
        is.dev ? process.env["ELECTRON_RENDERER_URL"] : undefined,
      )
    )
      return;
    event.preventDefault();
    openExternalUrl(url);
  });
  mainWindow.webContents.on(
    "will-attach-webview",
    (event, webPreferences, params) => {
      const isWebPreview = params.partition === "web-preview";
      if (!isAllowedWebviewUrl(params.src, isWebPreview)) {
        event.preventDefault();
        console.warn("[SECURITY] Blocked webview attachment for untrusted URL");
        return;
      }
      hardenWebviewPreferences(webPreferences);
    },
  );
  mainWindow.webContents.on("context-menu", (_event, params) => {
    showChatContextMenu(mainWindow, params);
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(rendererHtmlPath);
  }
}
