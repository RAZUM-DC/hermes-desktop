import { describe, expect, it } from "vitest";
import {
  acceleratorFromEvent,
  checkHotkey,
  checkInAppHotkey,
  formatAccelerator,
  isInAppAction,
  mainKeyFromCode,
  NEXT_CHAT_DEFAULT,
  PREV_CHAT_DEFAULT,
} from "./hotkeys";

function press(
  code: string,
  mods: Partial<{
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
  }> = {},
): Parameters<typeof acceleratorFromEvent>[0] {
  return {
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  };
}

describe("acceleratorFromEvent", () => {
  it("собирает комбинацию в порядке, который понимает Electron", () => {
    expect(
      acceleratorFromEvent(press("KeyH", { ctrlKey: true, altKey: true })),
    ).toBe("Control+Alt+H");
  });

  it("берёт физическую клавишу, а не букву раскладки", () => {
    // На русской раскладке эта же клавиша даёт «р» в event.key.
    expect(acceleratorFromEvent(press("KeyH", { ctrlKey: true }))).toBe(
      "Control+H",
    );
  });

  it("не собирает ничего, пока нажаты одни модификаторы", () => {
    expect(acceleratorFromEvent(press("ControlLeft", { ctrlKey: true }))).toBe(
      null,
    );
  });

  it("понимает пробел и функциональные клавиши", () => {
    expect(acceleratorFromEvent(press("Space", { ctrlKey: true }))).toBe(
      "Control+Space",
    );
    expect(acceleratorFromEvent(press("F9", { altKey: true }))).toBe("Alt+F9");
  });
});

describe("checkHotkey", () => {
  it("пропускает нормальную комбинацию", () => {
    expect(checkHotkey("Control+Alt+H")).toBe(null);
  });

  it("требует Ctrl, Alt или Win", () => {
    // Иначе комбинация перехватывала бы обычный набор текста.
    expect(checkHotkey("H")).toBe("needs-modifier");
    expect(checkHotkey("Shift+H")).toBe("needs-modifier");
  });

  it("не принимает одни модификаторы", () => {
    expect(checkHotkey("Control+Alt")).toBe("modifier-only");
    expect(checkHotkey("")).toBe("modifier-only");
  });

  it("отклоняет комбинации, занятые самим приложением", () => {
    expect(checkHotkey("Control+Shift+Space")).toBe("reserved");
  });

  it("отклоняет клавиши, которых система не отдаёт", () => {
    expect(checkHotkey("Control+Alt+Меню")).toBe("unsupported");
  });
});

describe("mainKeyFromCode", () => {
  it("переводит коды в имена, понятные Electron", () => {
    expect(mainKeyFromCode("KeyQ")).toBe("Q");
    expect(mainKeyFromCode("Digit7")).toBe("7");
    expect(mainKeyFromCode("ArrowUp")).toBe("Up");
    expect(mainKeyFromCode("ShiftLeft")).toBe(null);
  });
});

describe("formatAccelerator", () => {
  it("показывает комбинацию так, как её называют на клавиатуре", () => {
    expect(formatAccelerator("Control+Alt+H")).toBe("Ctrl + Alt + H");
    expect(formatAccelerator("Super+K")).toBe("Win + K");
  });
});

describe("checkHotkey и вторая комбинация", () => {
  it("не даёт назначить то, что уже занято другим действием приложения", () => {
    expect(checkHotkey("Control+Alt+S", ["Control+Alt+S"])).toBe("reserved");
  });

  it("не мешает оставить комбинацию у того же действия", () => {
    expect(checkHotkey("Control+Alt+H", ["Control+Alt+S"])).toBe(null);
  });
});

describe("внутриоконные комбинации", () => {
  it("узнаёт свои действия и не путает их с глобальными", () => {
    expect(isInAppAction("nextChat")).toBe(true);
    expect(isInAppAction("prevChat")).toBe(true);
    expect(isInAppAction("switchChat")).toBe(true);
    expect(isInAppAction("screenshot")).toBe(false);
    expect(isInAppAction(undefined)).toBe(false);
  });

  it("принимает Alt со стрелками — переключение вкладок по умолчанию", () => {
    expect(checkInAppHotkey(NEXT_CHAT_DEFAULT)).toBe(null);
    expect(checkInAppHotkey(PREV_CHAT_DEFAULT)).toBe(null);
  });

  it("не даёт двум внутриоконным действиям одну комбинацию", () => {
    expect(checkInAppHotkey(NEXT_CHAT_DEFAULT, [NEXT_CHAT_DEFAULT])).toBe(
      "reserved",
    );
  });
});
