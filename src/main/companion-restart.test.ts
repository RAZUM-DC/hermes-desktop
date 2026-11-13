// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", isPackaged: false, getAppPath: () => "/tmp" },
  shell: { openExternal: vi.fn() },
}));

import {
  COMPANION_RESTART_DELAYS_MS,
  companionRestartDelay,
} from "./companion";

// @lat: [[mac-companion#Companion lifecycle]]
describe("companionRestartDelay", () => {
  it("не перезапускает после штатного выхода (код 0: уже запущен другой экземпляр)", () => {
    expect(companionRestartDelay(0, 0)).toBeNull();
  });

  it("перезапускает после падения с нарастающей задержкой", () => {
    expect(companionRestartDelay(1, 1)).toBe(COMPANION_RESTART_DELAYS_MS[0]);
    expect(companionRestartDelay(null, 2)).toBe(COMPANION_RESTART_DELAYS_MS[1]);
    expect(companionRestartDelay(2, COMPANION_RESTART_DELAYS_MS.length)).toBe(
      COMPANION_RESTART_DELAYS_MS[COMPANION_RESTART_DELAYS_MS.length - 1],
    );
  });

  it("сдаётся, если падений в окне больше, чем ступеней задержки", () => {
    expect(
      companionRestartDelay(1, COMPANION_RESTART_DELAYS_MS.length + 1),
    ).toBeNull();
  });
});
