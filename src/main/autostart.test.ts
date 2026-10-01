// @vitest-environment node

import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  userData: "",
  packaged: true,
  loginItem: { openAtLogin: false } as { openAtLogin: boolean },
  lastSet: null as unknown,
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mockState.packaged;
    },
    getPath: () => mockState.userData,
    getLoginItemSettings: () => mockState.loginItem,
    setLoginItemSettings: (opts: unknown) => {
      mockState.lastSet = opts;
      mockState.loginItem = {
        openAtLogin: (opts as { openAtLogin: boolean }).openAtLogin,
      };
    },
  },
}));

async function mod(): Promise<typeof import("./autostart")> {
  return import("./autostart");
}

describe("автозапуск", () => {
  // Тесты идут на Linux, а автозапуск ограничен Windows и macOS: без подмены
  // платформы проверки уходили бы в ранний выход и проходили впустую.
  const realPlatform = process.platform;
  const setPlatform = (value: string): void => {
    Object.defineProperty(process, "platform", {
      value,
      configurable: true,
    });
  };

  beforeEach(() => {
    setPlatform("win32");
    mockState.userData = mkdtempSync(join(tmpdir(), "hermes-autostart-"));
    mockState.packaged = true;
    mockState.loginItem = { openAtLogin: false };
    mockState.lastSet = null;
    vi.resetModules();
  });

  afterEach(() => {
    setPlatform(realPlatform);
    rmSync(mockState.userData, { recursive: true, force: true });
    delete process.env.PORTABLE_EXECUTABLE_FILE;
  });

  describe("признак скрытого старта", () => {
    it("ловит ключ среди прочих аргументов", async () => {
      const { shouldStartHidden, HIDDEN_FLAG } = await mod();
      expect(shouldStartHidden(["app.exe", HIDDEN_FLAG])).toBe(true);
      expect(
        shouldStartHidden(["app.exe", "--no-sandbox", "--hidden", "--foo"]),
      ).toBe(true);
    });

    it("без ключа не срабатывает", async () => {
      const { shouldStartHidden } = await mod();
      expect(shouldStartHidden(["app.exe"])).toBe(false);
      expect(shouldStartHidden([])).toBe(false);
    });

    it("не путается в похожих аргументах", async () => {
      const { shouldStartHidden } = await mod();
      expect(shouldStartHidden(["app.exe", "--hidden-thing"])).toBe(false);
      expect(shouldStartHidden(["app.exe", "--not--hidden"])).toBe(false);
    });
  });

  describe("чтение и запись", () => {
    it("включает и выключает, спрашивая систему о результате", async () => {
      const { isAutostartEnabled, setAutostart } = await mod();
      expect(isAutostartEnabled()).toBe(false);
      expect(setAutostart(true)).toBe(true);
      expect(isAutostartEnabled()).toBe(true);
      expect(setAutostart(false)).toBe(false);
      expect(isAutostartEnabled()).toBe(false);
    });

    it("прописывает скрытый старт и явный путь", async () => {
      const { setAutostart, HIDDEN_FLAG } = await mod();
      setAutostart(true);
      const opts = mockState.lastSet as { args: string[]; path: string };
      expect(opts.args).toEqual([HIDDEN_FLAG]);
      expect(opts.path).toBeTruthy();
    });

    it("для портабла берёт настоящий .exe, а не копию во временной папке", async () => {
      process.env.PORTABLE_EXECUTABLE_FILE = "D:\\Tools\\hermes.exe";
      vi.resetModules();
      const { setAutostart } = await mod();
      setAutostart(true);
      // Иначе в автозагрузке осталась бы запись в %TEMP%, которую Windows
      // вычистит, и автозапуск молча перестал бы работать.
      expect((mockState.lastSet as { path: string }).path).toBe(
        "D:\\Tools\\hermes.exe",
      );
    });

    it("при запуске из исходников молча отказывается", async () => {
      mockState.packaged = false;
      mockState.loginItem = { openAtLogin: true };
      vi.resetModules();
      const { isAutostartEnabled, setAutostart, isAutostartSupported } =
        await mod();
      // Иначе в автозагрузку попал бы путь к electron.exe из node_modules,
      // который протухает после первой же пересборки.
      expect(isAutostartEnabled()).toBe(false);
      expect(setAutostart(true)).toBe(false);
      expect(isAutostartSupported()).toBe(false);
    });
  });

  describe("включение по умолчанию", () => {
    const marker = (): string =>
      join(mockState.userData, "autostart-initialized");

    it("включается при первом запуске", async () => {
      const { initAutostartDefault, isAutostartEnabled } = await mod();
      expect(isAutostartEnabled()).toBe(false);
      initAutostartDefault();
      expect(isAutostartEnabled()).toBe(true);
      expect(existsSync(marker())).toBe(true);
    });

    it("не возвращает галочку, которую человек снял", async () => {
      const { initAutostartDefault, setAutostart, isAutostartEnabled } =
        await mod();
      initAutostartDefault();
      setAutostart(false);
      // Второй запуск: отметка на месте, трогать настройку нельзя — иначе
      // снятая галочка возвращалась бы сама, и настройки бы не было вовсе.
      initAutostartDefault();
      expect(isAutostartEnabled()).toBe(false);
    });

    it("не трогает автозагрузку на Linux", async () => {
      setPlatform("linux");
      vi.resetModules();
      const { initAutostartDefault, isAutostartSupported } = await mod();
      expect(isAutostartSupported()).toBe(false);
      initAutostartDefault();
      expect(existsSync(marker())).toBe(false);
    });

    it("ничего не делает при запуске из исходников", async () => {
      mockState.packaged = false;
      vi.resetModules();
      const { initAutostartDefault } = await mod();
      initAutostartDefault();
      expect(existsSync(marker())).toBe(false);
    });
  });
});
