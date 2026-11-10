import { app, ipcMain, type BrowserWindow } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { AppUpdater } from "electron-updater";
import { dirname, join } from "path";
import { updaterLogger } from "../updater-log";
import { verifyPinnedUpdateSignature } from "./update-signature";

interface UpdaterDeps {
  getMainWindow: () => BrowserWindow | null;
}

let autoUpdaterInstance: AppUpdater | null = null;

function updatePreferencesPath(): string {
  return join(app.getPath("userData"), "update-preferences.json");
}

function getAutoUpgradeEnabled(): boolean {
  const file = updatePreferencesPath();
  if (!existsSync(file)) {
    return true;
  }

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      autoUpgrade?: unknown;
    };
    return parsed.autoUpgrade !== false;
  } catch {
    return true;
  }
}

function setAutoUpgradeEnabled(enabled: boolean): void {
  const file = updatePreferencesPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ autoUpgrade: enabled }, null, 2)}\n`);
}

/**
 * Установка «на всю машину» — это MSI, и только MSI. Профиль nsis собран с
 * `perMachine: false` и всегда ложится в профиль пользователя
 * (%LOCALAPPDATA%\Programs), portable вообще распаковывается во временную
 * папку. Поэтому каталог внутри %ProgramFiles% однозначно означает msi-пакет.
 *
 * Зачем это знать апдейтеру: electron-updater умеет обновлять только nsis.
 * Из MSI-установки он скачал бы setup.exe и поставил рядом вторую копию
 * приложения — в профиле пользователя, мимо записи MSI в списке установленных
 * программ. Человек получил бы две версии, и ни одна не знала бы о другой.
 * Машины, раскатанные политикой, обновляет администратор следующим .msi.
 *
 * Сравнение по префиксу пути, а не по равенству: приложение лежит в подкаталоге
 * (%ProgramFiles%\hermes-desktop\...). Разделитель в конце обязателен, иначе
 * «C:\Program Files Custom\...» тоже прошло бы проверку.
 */
export function isPerMachineInstall(
  execPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") {
    return false;
  }

  const target = execPath.replace(/\//g, "\\").toLowerCase();
  return [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432]
    .filter(
      (root): root is string =>
        typeof root === "string" && root.trim().length > 0,
    )
    .some((root) => {
      const normalized = root
        .replace(/\//g, "\\")
        .replace(/\\+$/, "")
        .toLowerCase();
      return target.startsWith(`${normalized}\\`);
    });
}

/** Ошибки апдейтера бывают многострочными (сырой JSON подписи и т.п.);
 *  в подсказку кнопки идёт только первая строка, полный текст — в updater.log. */
export function firstLine(message: string): string {
  const line = (message || "").split(/\r?\n/)[0].trim();
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

export function setupUpdater({ getMainWindow }: UpdaterDeps): void {
  ipcMain.handle("get-app-version", () => app.getVersion());
  ipcMain.handle("get-auto-upgrade-enabled", () => getAutoUpgradeEnabled());
  ipcMain.handle("set-auto-upgrade-enabled", (_event, enabled: boolean) => {
    setAutoUpgradeEnabled(enabled);
    if (autoUpdaterInstance) {
      autoUpdaterInstance.autoDownload = enabled;
    }
    return true;
  });

  const isPortableBuild = !!process.env.PORTABLE_EXECUTABLE_DIR;
  // electron-builder writes app-update.yml next to the app only when the
  // build has a publish configuration. A locally packaged build (or an
  // unpacked win-unpacked folder run directly) has none, so electron-updater
  // would fail on its very first check and light up the sidebar with a red
  // "update failed" button about an update channel that does not exist.
  const hasUpdateFeed = existsSync(
    join(process.resourcesPath || "", "app-update.yml"),
  );
  // MSI-установку обновляет администратор, не приложение — см. комментарий к
  // isPerMachineInstall.
  const isManagedInstall = isPerMachineInstall(process.execPath);
  if (
    !app.isPackaged ||
    isPortableBuild ||
    isManagedInstall ||
    !hasUpdateFeed
  ) {
    autoUpdaterInstance = null;
    ipcMain.handle("check-for-updates", async () => null);
    ipcMain.handle("download-update", () => true);
    ipcMain.handle("install-update", () => {});
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { autoUpdater } = require("electron-updater") as {
    autoUpdater: AppUpdater;
  };

  autoUpdaterInstance = autoUpdater;
  autoUpdater.logger = updaterLogger;
  autoUpdater.autoDownload = getAutoUpgradeEnabled();
  autoUpdater.autoInstallOnAppQuit = true;
  if (process.platform === "win32") {
    // Релизы подписаны самоподписанным сертификатом: штатная проверка требует
    // доверия Windows и отвергает их. Доверяем закреплённому отпечатку —
    // см. update-signature.ts (BUG-080).
    (
      autoUpdater as AppUpdater & {
        verifyUpdateCodeSignature?: (
          publisherNames: string[],
          file: string,
        ) => Promise<string | null>;
      }
    ).verifyUpdateCodeSignature = (publisherNames, file) =>
      verifyPinnedUpdateSignature(publisherNames, file, updaterLogger);
  }

  // Идёт ли загрузка, которую пользователь не запускал сам (autoDownload).
  // Её сбой иначе виден только в логе, а кнопка в интерфейсе навсегда
  // застывает на «Загрузка 100%» (BUG-080).
  let backgroundDownload = false;
  let explicitDownload = false;

  autoUpdater.on("update-available", (info) => {
    backgroundDownload = autoUpdater.autoDownload && !explicitDownload;
    getMainWindow()?.webContents.send("update-available", {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    getMainWindow()?.webContents.send("update-download-progress", {
      percent: Math.round(progress.percent),
    });
  });
  autoUpdater.on("update-downloaded", () => {
    backgroundDownload = false;
    getMainWindow()?.webContents.send("update-downloaded");
  });
  // Background checks run on a timer that the user never asked for, so their
  // failures (offline, blocked by a corporate proxy, feed temporarily down)
  // belong in the log, not in the UI. Errors from the explicit "download"
  // action are still reported below — there the user is waiting for an
  // answer and silence would be worse.
  autoUpdater.on("error", (err) => {
    updaterLogger.warn(`update check failed: ${err.message}`);
    if (backgroundDownload && !explicitDownload) {
      backgroundDownload = false;
      getMainWindow()?.webContents.send("update-error", firstLine(err.message));
    }
  });

  ipcMain.handle("check-for-updates", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.updateInfo?.version || null;
    } catch {
      return null;
    }
  });
  ipcMain.handle("download-update", async () => {
    explicitDownload = true;
    backgroundDownload = false;
    try {
      await autoUpdater.downloadUpdate();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      getMainWindow()?.webContents.send("update-error", firstLine(message));
      return false;
    } finally {
      explicitDownload = false;
    }
  });
  ipcMain.handle("install-update", () => {
    updaterLogger.info(
      "Restart requested by user — calling quitAndInstall(isSilent=false, isForceRunAfter=true)",
    );
    autoUpdater.quitAndInstall(false, true);
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);

  // Периодическая проверка обновлений во время работы (не только при старте).
  // Раз в час; при autoDownload загрузка и уведомление идут сами, установка —
  // по кнопке пользователя. Интервал переопределяется UPDATE_CHECK_INTERVAL_MS.
  const hourMs = 60 * 60 * 1000;
  const envMs = Number(process.env.UPDATE_CHECK_INTERVAL_MS);
  const intervalMs = Number.isFinite(envMs) && envMs > 0 ? envMs : hourMs;
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, intervalMs);
}
