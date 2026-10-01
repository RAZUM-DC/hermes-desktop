import { describe, expect, it, vi } from "vitest";

// hotkey-store тянет electron ради пути к userData — для чистой функции он не
// нужен, поэтому модуль подменяем.
vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));

import { resolveWindowHotkey } from "./window-hotkeys";

const map = {
  switchChat: "",
  nextChat: "Alt+Right",
  prevChat: "Alt+Left",
  insertDraft: "Alt+S",
};

const input = (
  code: string,
  mods: Partial<{
    type: string;
    control: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
  }> = {},
): Parameters<typeof resolveWindowHotkey>[0] => ({
  type: "keyDown",
  code,
  control: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods,
});

describe("resolveWindowHotkey", () => {
  it("узнаёт комбинации в полях события главного процесса", () => {
    expect(resolveWindowHotkey(input("ArrowRight", { alt: true }), map)).toBe(
      "nextChat",
    );
    expect(resolveWindowHotkey(input("ArrowLeft", { alt: true }), map)).toBe(
      "prevChat",
    );
    expect(resolveWindowHotkey(input("KeyS", { alt: true }), map)).toBe(
      "insertDraft",
    );
  });

  it("не срабатывает без модификатора и на отпускании", () => {
    expect(resolveWindowHotkey(input("ArrowRight"), map)).toBe(null);
    expect(
      resolveWindowHotkey(
        input("ArrowRight", { alt: true, type: "keyUp" }),
        map,
      ),
    ).toBe(null);
  });

  it("следует настроенной комбинации, а не умолчанию", () => {
    const custom = { ...map, nextChat: "Control+PageDown" };
    expect(
      resolveWindowHotkey(input("PageDown", { control: true }), custom),
    ).toBe("nextChat");
    expect(
      resolveWindowHotkey(input("ArrowRight", { alt: true }), custom),
    ).toBe(null);
  });

  it("switchChat остаётся рендереру: его механика здесь не видна", () => {
    const custom = { ...map, switchChat: "Control+Tab" };
    expect(resolveWindowHotkey(input("Tab", { control: true }), custom)).toBe(
      null,
    );
  });
});
