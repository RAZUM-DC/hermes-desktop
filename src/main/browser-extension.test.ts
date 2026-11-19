// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  browsersToRemind,
  browserUserDataDir,
  detectBrowserExtension,
  EXTENSION_ID,
  EXTENSION_STORE_URL,
  readReminderPrefs,
  snoozedPrefs,
  storeLaunchCommand,
  writeReminderPrefs,
} from "./browser-extension";

let home: string;
const env = (): {
  platform: NodeJS.Platform;
  home: string;
  vars: Record<string, string>;
} => ({
  platform: "win32",
  home,
  vars: { LOCALAPPDATA: join(home, "AppData", "Local") },
});

function profile(
  browser: "chrome" | "yandex",
  name: string,
  opts: {
    lastUsed?: string;
    secure?: object;
    prefs?: object;
    extDir?: boolean;
  } = {},
): string {
  const root = browserUserDataDir(browser, env())!;
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, "Local State"),
    JSON.stringify({ profile: { last_used: opts.lastUsed ?? name } }),
  );
  if (opts.secure)
    writeFileSync(
      join(root, name, "Secure Preferences"),
      JSON.stringify(opts.secure),
    );
  if (opts.prefs)
    writeFileSync(join(root, name, "Preferences"), JSON.stringify(opts.prefs));
  if (opts.extDir)
    mkdirSync(join(root, name, "Extensions", EXTENSION_ID), {
      recursive: true,
    });
  return root;
}

const withExt = (entry: object): object => ({
  extensions: { settings: { [EXTENSION_ID]: entry, other: { state: 1 } } },
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "browser-ext-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// @lat: [[browser-extension#Detection]]
describe("detectBrowserExtension", () => {
  it("видит только установленные браузеры", () => {
    expect(detectBrowserExtension(env())).toEqual([]);
    profile("yandex", "Default");
    expect(detectBrowserExtension(env())).toEqual([
      { browser: "yandex", profile: "Default", status: "missing" },
    ]);
  });

  it("включённое расширение в Secure Preferences — installed, выключенное — disabled", () => {
    profile("chrome", "Default", { secure: withExt({ disable_reasons: 0 }) });
    profile("yandex", "Default", { prefs: withExt({ disable_reasons: [1] }) });
    expect(detectBrowserExtension(env())).toEqual([
      { browser: "chrome", profile: "Default", status: "installed" },
      { browser: "yandex", profile: "Default", status: "disabled" },
    ]);
  });

  it("старый формат state 0 — disabled; без записи в настройках, но с каталогом — installed", () => {
    profile("chrome", "Default", { prefs: withExt({ state: 0 }) });
    profile("yandex", "Default", { extDir: true });
    expect(detectBrowserExtension(env()).map((b) => b.status)).toEqual([
      "disabled",
      "installed",
    ]);
  });

  it("смотрит профиль, которым пользовались последним", () => {
    const root = profile("chrome", "Profile 2", { secure: withExt({}) });
    mkdirSync(join(root, "Default"), { recursive: true });
    expect(detectBrowserExtension(env())[0]).toEqual({
      browser: "chrome",
      profile: "Profile 2",
      status: "installed",
    });
  });

  it("если last_used указывает на несуществующий профиль — Default", () => {
    profile("chrome", "Default", { lastUsed: "Profile 9" });
    expect(detectBrowserExtension(env())[0].profile).toBe("Default");
  });

  it("битые файлы настроек не роняют проверку", () => {
    const root = profile("chrome", "Default");
    writeFileSync(join(root, "Default", "Secure Preferences"), "{not json");
    writeFileSync(join(root, "Local State"), "garbage");
    expect(detectBrowserExtension(env())[0].status).toBe("missing");
  });

  it("пути профилей на macOS", () => {
    const mac = { ...env(), platform: "darwin" as NodeJS.Platform };
    expect(browserUserDataDir("chrome", mac)).toBe(
      join(home, "Library", "Application Support", "Google", "Chrome"),
    );
    expect(browserUserDataDir("yandex", mac)).toBe(
      join(home, "Library", "Application Support", "Yandex", "YandexBrowser"),
    );
  });
});

describe("напоминание", () => {
  const missing = {
    browser: "chrome" as const,
    profile: "Default",
    status: "missing" as const,
  };
  const ok = {
    browser: "yandex" as const,
    profile: "Default",
    status: "installed" as const,
  };

  it("напоминает только о браузерах без включённого расширения", () => {
    expect(
      browsersToRemind([missing, ok], { remind: true, snoozeUntil: 0 }, 1),
    ).toEqual([missing]);
  });

  it("«Позже» — неделя тишины, «Не напоминать» — совсем", () => {
    const now = 1_000_000;
    const snoozed = snoozedPrefs({ remind: true, snoozeUntil: 0 }, now);
    expect(browsersToRemind([missing], snoozed, now + 6 * 86_400_000)).toEqual(
      [],
    );
    expect(browsersToRemind([missing], snoozed, now + 8 * 86_400_000)).toEqual([
      missing,
    ]);
    expect(
      browsersToRemind([missing], { remind: false, snoozeUntil: 0 }, now),
    ).toEqual([]);
  });

  it("настройки читаются и пишутся; по умолчанию напоминания включены", () => {
    const file = join(home, "ud", "browser-extension.json");
    expect(readReminderPrefs(file)).toEqual({ remind: true, snoozeUntil: 0 });
    writeReminderPrefs(file, { remind: false, snoozeUntil: 5 });
    expect(readReminderPrefs(file)).toEqual({ remind: false, snoozeUntil: 5 });
  });
});

describe("storeLaunchCommand", () => {
  it("Windows: запускает найденный exe браузера со страницей расширения", () => {
    const base = env();
    const e = { ...base, vars: { ...base.vars, PROGRAMFILES: "C:\\PF" } };
    const chrome = join(
      "C:\\PF",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    );
    expect(storeLaunchCommand("chrome", e, (p) => p === chrome)).toEqual([
      chrome,
      [EXTENSION_STORE_URL],
    ]);
    const yandex = join(
      base.vars.LOCALAPPDATA,
      "Yandex",
      "YandexBrowser",
      "Application",
      "browser.exe",
    );
    expect(storeLaunchCommand("yandex", e, (p) => p === yandex)).toEqual([
      yandex,
      [EXTENSION_STORE_URL],
    ]);
    expect(storeLaunchCommand("yandex", e, () => false)).toBeNull();
  });

  it("macOS: open -a с именем приложения", () => {
    const mac = { ...env(), platform: "darwin" as NodeJS.Platform };
    expect(storeLaunchCommand("yandex", mac)).toEqual([
      "open",
      ["-a", "Yandex", EXTENSION_STORE_URL],
    ]);
  });
});
