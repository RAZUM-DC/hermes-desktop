import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  globalShortcut: { register: vi.fn() },
  ipcMain: { handle: vi.fn() },
  screen: { getCursorScreenPoint: vi.fn(), getDisplayNearestPoint: vi.fn() },
}));
vi.mock("@electron-toolkit/utils", () => ({ is: { dev: false } }));
vi.mock("../voice-sidecar", () => ({ watchHotkeyRelease: vi.fn() }));

import {
  hotkeyEventCodes,
  hotkeyEventKeys,
  hotkeyVirtualKeys,
  overlayBounds,
} from "./voice-overlay";

describe("hotkeyEventKeys", () => {
  it("maps an accelerator to KeyboardEvent.key names", () => {
    expect(hotkeyEventKeys("Control+Alt+Space")).toEqual([
      "Control",
      "Alt",
      " ",
    ]);
  });

  it("understands the aliases Electron accepts", () => {
    expect(hotkeyEventKeys("CommandOrControl+Shift+D")).toEqual([
      "Control",
      "Shift",
      "d",
    ]);
  });

  it("ignores empty segments", () => {
    expect(hotkeyEventKeys("Control++Alt")).toEqual(["Control", "Alt"]);
  });

  it("keeps named keys it does not translate", () => {
    expect(hotkeyEventKeys("Control+F9")).toEqual(["Control", "F9"]);
  });
});

describe("overlayBounds", () => {
  it("centres the window horizontally in the work area", () => {
    const b = overlayBounds(
      { x: 0, y: 0, width: 1920, height: 1080 },
      380,
      132,
      120,
    );
    expect(b.x).toBe(770);
    expect(b.width).toBe(380);
  });

  it("sits above the bottom edge by the given margin", () => {
    const b = overlayBounds(
      { x: 0, y: 0, width: 1920, height: 1080 },
      380,
      132,
      120,
    );
    expect(b.y).toBe(1080 - 132 - 120);
  });

  it("respects a work area that does not start at the origin", () => {
    const b = overlayBounds(
      { x: 1920, y: 40, width: 1280, height: 1000 },
      380,
      132,
      120,
    );
    expect(b.x).toBe(1920 + Math.round((1280 - 380) / 2));
    expect(b.y).toBe(40 + 1000 - 132 - 120);
  });
});

describe("hotkeyEventCodes", () => {
  it("gives the layout-independent code of the letter key", () => {
    // На русской раскладке KeyboardEvent.key для «H» приходит как «р»,
    // поэтому отпускание ловим ещё и по физическому коду клавиши.
    expect(hotkeyEventCodes("Control+Alt+H")).toEqual(["KeyH"]);
  });

  it("covers digits too", () => {
    expect(hotkeyEventCodes("Control+1")).toEqual(["Digit1"]);
  });

  it("has nothing to say about modifier-only combinations", () => {
    expect(hotkeyEventCodes("Control+Shift+Space")).toEqual([]);
  });
});

describe("hotkeyVirtualKeys", () => {
  it("gives the codes the system knows the keys by", () => {
    expect(hotkeyVirtualKeys("Control+Alt+H")).toEqual([0x11, 0x12, 0x48]);
  });

  it("различает комбинации двух диктовок", () => {
    // Наблюдатель следит за той комбинацией, которой начали запись. Если
    // перепутать их местами, «отпущено» прилетит сразу же: чужую-то клавишу
    // никто не держит, и запись оборвётся, не начавшись.
    expect(hotkeyVirtualKeys("Control+Alt+J")).toEqual([0x11, 0x12, 0x4a]);
    expect(hotkeyVirtualKeys("Control+Alt+J")).not.toEqual(
      hotkeyVirtualKeys("Control+Alt+H"),
    );
  });

  it("handles Space and Shift", () => {
    expect(hotkeyVirtualKeys("Control+Shift+Space")).toEqual([
      0x11, 0x10, 0x20,
    ]);
  });

  it("skips keys it cannot map, rather than watching the wrong one", () => {
    // Без кода функциональной клавиши наблюдатель просто не вооружится и
    // останется режим переключателя — это лучше, чем следить не за тем.
    expect(hotkeyVirtualKeys("Control+F2")).toEqual([0x11]);
  });
});
