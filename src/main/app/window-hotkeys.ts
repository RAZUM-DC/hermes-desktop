import { type BrowserWindow } from "electron";
import { readHotkeys } from "../hotkey-store";
import {
  matchesAccelerator,
  INSERT_DRAFT_DEFAULT,
  NEXT_CHAT_DEFAULT,
  PREV_CHAT_DEFAULT,
  WINDOW_INTERCEPTED_ACTIONS,
  type InAppHotkeyAction,
} from "../../shared/hotkeys";

/**
 * Внутриоконные комбинации, перехватываемые в главном процессе.
 *
 * Казалось бы, комбинация внутриоконная, и ловить её должен рендерер. Но на
 * Windows сочетания с Alt разбирает слой окна (скрытая строка меню и её
 * мнемоники) ещё до того, как событие попадёт на страницу, — до обработчика
 * в рендерере Alt+стрелка просто не доходит. `before-input-event` работает
 * выше этого слоя: он вызывается раньше и страницы, и меню, поэтому ловим
 * здесь, гасим событие и отправляем рендереру готовое действие.
 */

type HotkeyMap = Record<InAppHotkeyAction, string>;

let hotkeys: HotkeyMap = {
  switchChat: "",
  nextChat: NEXT_CHAT_DEFAULT,
  prevChat: PREV_CHAT_DEFAULT,
  insertDraft: INSERT_DRAFT_DEFAULT,
};

/** Перечитать комбинации после смены их в настройках. */
export function refreshWindowHotkeys(): void {
  const stored = readHotkeys();
  hotkeys = {
    // switchChat перехватывается рендерером: у него механика удержания.
    switchChat: "",
    nextChat: stored.nextChat || NEXT_CHAT_DEFAULT,
    prevChat: stored.prevChat || PREV_CHAT_DEFAULT,
    insertDraft: stored.insertDraft || INSERT_DRAFT_DEFAULT,
  };
}

/** Поля события главного процесса названы иначе, чем в DOM. */
export interface KeyInputLike {
  type: string;
  code: string;
  control: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/** Действие для нажатия, либо null — комбинация не наша. */
export function resolveWindowHotkey(
  input: KeyInputLike,
  map: HotkeyMap,
): InAppHotkeyAction | null {
  if (input.type !== "keyDown") return null;
  const like = {
    code: input.code,
    ctrlKey: input.control,
    altKey: input.alt,
    shiftKey: input.shift,
    metaKey: input.meta,
  };
  for (const action of WINDOW_INTERCEPTED_ACTIONS) {
    const accelerator = map[action];
    if (accelerator && matchesAccelerator(like, accelerator)) return action;
  }
  return null;
}

export function attachWindowHotkeys(win: BrowserWindow): void {
  refreshWindowHotkeys();
  win.webContents.on("before-input-event", (event, input) => {
    const action = resolveWindowHotkey(input, hotkeys);
    if (!action) return;
    // Гасим до страницы: иначе Alt+стрелка ещё и подвинет каретку в поле
    // ввода, а на Windows может открыть строку меню.
    event.preventDefault();
    console.log("[HOTKEY] window action", action);
    win.webContents.send("in-app-hotkey", action);
  });
}
