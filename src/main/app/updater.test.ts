import { describe, expect, it, vi } from "vitest";

// updater.ts тянет electron ради app/ipcMain — для чистой функции они не
// нужны, поэтому модуль подменяем.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  ipcMain: { handle: () => {} },
}));

import { isPerMachineInstall } from "./updater";

const WIN_ENV: NodeJS.ProcessEnv = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  ProgramW6432: "C:\\Program Files",
};

describe("isPerMachineInstall", () => {
  it("распознаёт установку MSI в Program Files", () => {
    expect(
      isPerMachineInstall(
        "C:\\Program Files\\hermes-desktop\\hermes-agent.exe",
        WIN_ENV,
        "win32",
      ),
    ).toBe(true);
  });

  it("распознаёт 32-разрядный Program Files", () => {
    expect(
      isPerMachineInstall(
        "C:\\Program Files (x86)\\hermes-desktop\\hermes-agent.exe",
        WIN_ENV,
        "win32",
      ),
    ).toBe(true);
  });

  it("не трогает установку nsis в профиле пользователя", () => {
    expect(
      isPerMachineInstall(
        "C:\\Users\\ivan\\AppData\\Local\\Programs\\hermes-desktop\\hermes-agent.exe",
        WIN_ENV,
        "win32",
      ),
    ).toBe(false);
  });

  it("не трогает portable-сборку во временной папке", () => {
    expect(
      isPerMachineInstall(
        "C:\\Users\\ivan\\AppData\\Local\\Temp\\2F3A\\hermes-agent.exe",
        WIN_ENV,
        "win32",
      ),
    ).toBe(false);
  });

  it("сравнивает без учёта регистра — Windows так и делает", () => {
    expect(
      isPerMachineInstall(
        "c:\\PROGRAM FILES\\hermes-desktop\\hermes-agent.exe",
        WIN_ENV,
        "win32",
      ),
    ).toBe(true);
  });

  it("не принимает каталог, лишь начинающийся так же", () => {
    expect(
      isPerMachineInstall(
        "C:\\Program Files Custom\\hermes-desktop\\hermes-agent.exe",
        WIN_ENV,
        "win32",
      ),
    ).toBe(false);
  });

  it("переживает завершающий разделитель в переменной окружения", () => {
    expect(
      isPerMachineInstall(
        "C:\\Program Files\\hermes-desktop\\hermes-agent.exe",
        { ProgramFiles: "C:\\Program Files\\" },
        "win32",
      ),
    ).toBe(true);
  });

  it("переживает пустое и отсутствующее окружение", () => {
    expect(
      isPerMachineInstall(
        "C:\\Program Files\\hermes-desktop\\hermes-agent.exe",
        { ProgramFiles: "   " },
        "win32",
      ),
    ).toBe(false);
    expect(
      isPerMachineInstall(
        "C:\\Program Files\\hermes-desktop\\hermes-agent.exe",
        {},
        "win32",
      ),
    ).toBe(false);
  });

  it("на macOS и Linux всегда false — MSI там не бывает", () => {
    expect(
      isPerMachineInstall("/Applications/Hermes.app", WIN_ENV, "darwin"),
    ).toBe(false);
    expect(isPerMachineInstall("/opt/hermes/hermes", WIN_ENV, "linux")).toBe(
      false,
    );
  });
});
