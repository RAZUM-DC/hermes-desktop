// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  packaged: true,
  loginItem: { openAtLogin: false } as { openAtLogin: boolean },
  lastSet: null as unknown,
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mockState.packaged;
    },
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
      // Подстрока «--hidden» внутри другого ключа — не наш случай.
      expect(shouldStartHidden(["app.exe", "--hidden-thing"])).toBe(false);
      expect(shouldStartHidden(["app.exe", "--not--hidden"])).toBe(false);
    });
  });

  describe("чтение и запись", () => {
    it("включает и выключает, спрашивая систему о результате", async () => {
      mockState.packaged = true;
      mockState.loginItem = { openAtLogin: false };
      const { isAutostartEnabled, setAutostart } = await mod();
      expect(isAutostartEnabled()).toBe(false);
      expect(setAutostart(true)).toBe(true);
      expect(isAutostartEnabled()).toBe(true);
      expect(setAutostart(false)).toBe(false);
      expect(isAutostartEnabled()).toBe(false);
    });

    it("для портабла берёт настоящий .exe, а не копию во временной папке", async () => {
      mockState.packaged = true;
      vi.resetModules();
      process.env.PORTABLE_EXECUTABLE_FILE = "D:\\Tools\\hermes.exe";
      try {
        const { setAutostart } = await mod();
        setAutostart(true);
        const opts = mockState.lastSet as { path: string };
        // Иначе в автозагрузке осталась бы запись в %TEMP%, которую Windows
        // вычистит, и автозапуск молча перестал бы работать.
        expect(opts.path).toBe("D:\\Tools\\hermes.exe");
      } finally {
        delete process.env.PORTABLE_EXECUTABLE_FILE;
      }
    });

    it("прописывает скрытый старт и явный путь", async () => {
      mockState.packaged = true;
      const { setAutostart, HIDDEN_FLAG } = await mod();
      setAutostart(true);
      const opts = mockState.lastSet as { args: string[]; path: string };
      expect(opts.args).toEqual([HIDDEN_FLAG]);
      expect(opts.path).toBeTruthy();
    });

    it("в неупакованной сборке молча отказывается", async () => {
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
});
