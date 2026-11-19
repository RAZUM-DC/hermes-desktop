import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/**
 * Проверка корпоративного расширения «РАЗУМ ИИ-помощник» в Chrome и
 * Яндекс.Браузере и предложение его установить.
 *
 * Поставить расширение само приложение не может: Chrome и Яндекс.Браузер
 * разрешают установку из магазина только по клику пользователя или политикой
 * администратора (в Яндекс.Браузер ИТ политикой поставить не может). Поэтому
 * мы только читаем файлы профиля браузера — сам браузер не запускаем — и, если
 * расширения нет или оно выключено, открываем его страницу в магазине именно в
 * этом браузере. Яндекс.Браузер ставит расширения из магазина Chrome с тем же
 * ID, поэтому проверка одинаковая.
 *
 * Проверяется профиль, которым пользовались последним (`Local State` →
 * `profile.last_used`). Профиль Chrome, который открывает агент (режим
 * local-chrome), лежит в каталоге companion и сюда не попадает.
 */

export const EXTENSION_ID = "cbibinekkkfmndjkflmckjhnopgocpdc";
export const EXTENSION_STORE_URL = `https://chromewebstore.google.com/detail/${EXTENSION_ID}`;
const SNOOZE_DAYS = 7;

import type {
  BrowserExtensionInfo,
  BrowserId,
  ExtensionStatus,
} from "../shared/browser-extension";
export type { BrowserExtensionInfo, BrowserId, ExtensionStatus };

interface Env {
  platform: NodeJS.Platform;
  home: string;
  vars: Record<string, string | undefined>;
}

function defaultEnv(): Env {
  return { platform: process.platform, home: homedir(), vars: process.env };
}

/** Каталог пользовательских данных браузера на этой ОС. */
export function browserUserDataDir(
  browser: BrowserId,
  env: Env,
): string | null {
  const local = env.vars.LOCALAPPDATA || join(env.home, "AppData", "Local");
  switch (env.platform) {
    case "win32":
      return browser === "chrome"
        ? join(local, "Google", "Chrome", "User Data")
        : join(local, "Yandex", "YandexBrowser", "User Data");
    case "darwin": {
      const support = join(env.home, "Library", "Application Support");
      return browser === "chrome"
        ? join(support, "Google", "Chrome")
        : join(support, "Yandex", "YandexBrowser");
    }
    case "linux":
      return browser === "chrome"
        ? join(env.home, ".config", "google-chrome")
        : join(env.home, ".config", "yandex-browser");
    default:
      return null;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function get(obj: unknown, ...keys: string[]): unknown {
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function isDisabled(entry: Record<string, unknown>): boolean {
  // Старые версии Chromium: state 0 = выключено. Новые: непустые disable_reasons
  // (число-битовая маска или массив).
  if (entry.state === 0) return true;
  const reasons = entry.disable_reasons;
  if (typeof reasons === "number") return reasons !== 0;
  if (Array.isArray(reasons)) return reasons.length > 0;
  return false;
}

/** Состояние расширения в одном профиле браузера. */
export function extensionStatusInProfile(profileDir: string): ExtensionStatus {
  // Chromium хранит настройки расширений в Secure Preferences (Windows, macOS)
  // или в Preferences — смотрим оба.
  for (const name of ["Secure Preferences", "Preferences"]) {
    const prefs = readJson(join(profileDir, name));
    const entry = get(prefs, "extensions", "settings", EXTENSION_ID);
    if (entry && typeof entry === "object") {
      return isDisabled(entry as Record<string, unknown>)
        ? "disabled"
        : "installed";
    }
  }
  return existsSync(join(profileDir, "Extensions", EXTENSION_ID))
    ? "installed"
    : "missing";
}

/** Браузеры, установленные у пользователя, и состояние расширения в каждом. */
export function detectBrowserExtension(
  env: Env = defaultEnv(),
): BrowserExtensionInfo[] {
  const out: BrowserExtensionInfo[] = [];
  for (const browser of ["chrome", "yandex"] as BrowserId[]) {
    const root = browserUserDataDir(browser, env);
    if (!root || !existsSync(join(root, "Local State"))) continue;
    const last = get(
      readJson(join(root, "Local State")),
      "profile",
      "last_used",
    );
    let profile = typeof last === "string" && last ? last : "Default";
    if (!existsSync(join(root, profile))) profile = "Default";
    if (!existsSync(join(root, profile))) continue;
    out.push({
      browser,
      profile,
      status: extensionStatusInProfile(join(root, profile)),
    });
  }
  return out;
}

// ── Настройки напоминания ────────────────────────────────────────────────

export interface ReminderPrefs {
  remind: boolean;
  snoozeUntil: number;
}

export function readReminderPrefs(file: string): ReminderPrefs {
  const d = readJson(file);
  return {
    remind: d?.remind !== false,
    snoozeUntil: typeof d?.snoozeUntil === "number" ? d.snoozeUntil : 0,
  };
}

export function writeReminderPrefs(file: string, prefs: ReminderPrefs): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`);
}

export function snoozedPrefs(prefs: ReminderPrefs, now: number): ReminderPrefs {
  return { ...prefs, snoozeUntil: now + SNOOZE_DAYS * 24 * 60 * 60 * 1000 };
}

/** Браузеры, о которых сейчас надо напомнить (пусто — плашку не показывать). */
export function browsersToRemind(
  browsers: BrowserExtensionInfo[],
  prefs: ReminderPrefs,
  now: number,
): BrowserExtensionInfo[] {
  if (!prefs.remind || prefs.snoozeUntil > now) return [];
  return browsers.filter((b) => b.status !== "installed");
}

// ── Открыть страницу расширения в нужном браузере ────────────────────────

function browserExecutables(browser: BrowserId, env: Env): string[] {
  const v = env.vars;
  const local = v.LOCALAPPDATA || join(env.home, "AppData", "Local");
  const pf = [v.PROGRAMFILES, v["PROGRAMFILES(X86)"], v.ProgramW6432].filter(
    (p): p is string => !!p,
  );
  if (browser === "chrome") {
    return [
      join(local, "Google", "Chrome", "Application", "chrome.exe"),
      ...pf.map((p) =>
        join(p, "Google", "Chrome", "Application", "chrome.exe"),
      ),
    ];
  }
  return [
    join(local, "Yandex", "YandexBrowser", "Application", "browser.exe"),
    ...pf.map((p) =>
      join(p, "Yandex", "YandexBrowser", "Application", "browser.exe"),
    ),
  ];
}

/** Как запустить браузер с адресом: [команда, аргументы] или null. */
export function storeLaunchCommand(
  browser: BrowserId,
  env: Env = defaultEnv(),
  exists: (p: string) => boolean = existsSync,
): [string, string[]] | null {
  if (env.platform === "win32") {
    const exe = browserExecutables(browser, env).find(exists);
    return exe ? [exe, [EXTENSION_STORE_URL]] : null;
  }
  if (env.platform === "darwin") {
    return [
      "open",
      [
        "-a",
        browser === "chrome" ? "Google Chrome" : "Yandex",
        EXTENSION_STORE_URL,
      ],
    ];
  }
  if (env.platform === "linux") {
    return [
      browser === "chrome" ? "google-chrome" : "yandex-browser",
      [EXTENSION_STORE_URL],
    ];
  }
  return null;
}

/** Открыть страницу расширения в магазине. false — браузер не найден. */
export function openExtensionStore(browser: BrowserId): boolean {
  const cmd = storeLaunchCommand(browser);
  if (!cmd) return false;
  try {
    const child = spawn(cmd[0], cmd[1], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
