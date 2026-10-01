/**
 * Разбор и проверка горячих клавиш.
 *
 * Живёт в shared, потому что нужен обеим сторонам: окно настроек собирает
 * комбинацию из нажатия и тут же говорит, годится ли она, а главный процесс
 * теми же правилами проверяет то, что приехало от него, — доверять значению,
 * пришедшему из интерфейса, нельзя.
 */

/** Комбинации, которые приложение занимает само. */
export const BUILTIN_HOTKEYS: Record<string, string> = {
  "Control+Shift+Space": "quickCall",
};

export const VOICE_DICTATION_DEFAULT = "Control+Alt+H";
/**
 * Тихая диктовка: то же самое, но окно приложения не поднимается — заметка
 * просто ложится в карточку и ждёт. Рядом с основной по клавиатуре, чтобы
 * выбирать между ними, не переставляя руку.
 */
export const VOICE_DICTATION_QUIET_DEFAULT = "Control+Alt+J";
export const SCREENSHOT_DEFAULT = "Control+Alt+S";
export const REGION_DEFAULT = "Control+Alt+A";
/** Внутриоконная: панель недавних диалогов из сайдбара. */
export const SWITCH_CHAT_DEFAULT = "Control+Tab";
/** Внутриоконная: следующая вкладка в верхней строке. */
export const NEXT_CHAT_DEFAULT = "Alt+Right";
/** Внутриоконная: предыдущая вкладка в верхней строке. */
export const PREV_CHAT_DEFAULT = "Alt+Left";
/** Внутриоконная: вставить последний черновик в открытый диалог. */
export const INSERT_DRAFT_DEFAULT = "Alt+S";

/** Комбинации, которые система отдаёт нам даже когда окно свёрнуто. */
export type GlobalHotkeyAction =
  | "voiceDictation"
  | "voiceDictationQuiet"
  | "screenshot"
  | "region";

/**
 * Комбинации, работающие только в окне приложения. Система их не видит, так
 * что занимать ничего не нужно и конфликтовать они могут лишь со своими же.
 */
export type InAppHotkeyAction =
  | "switchChat"
  | "nextChat"
  | "prevChat"
  | "insertDraft";

export type HotkeyAction = GlobalHotkeyAction | InAppHotkeyAction;

export const GLOBAL_ACTIONS: readonly GlobalHotkeyAction[] = [
  "voiceDictation",
  "voiceDictationQuiet",
  "screenshot",
  "region",
];

export const IN_APP_ACTIONS: readonly InAppHotkeyAction[] = [
  "switchChat",
  "nextChat",
  "prevChat",
  "insertDraft",
];

/**
 * Внутриоконные действия, которые ловит главный процесс.
 *
 * `switchChat` сюда не входит: у него своя механика с удержанием и
 * отпусканием модификатора, которую видно только в рендерере. Остальные —
 * одиночные нажатия, и их проще перехватывать выше слоя окна, иначе
 * сочетания с Alt на Windows до страницы не доходят.
 */
export const WINDOW_INTERCEPTED_ACTIONS: readonly InAppHotkeyAction[] = [
  "nextChat",
  "prevChat",
  "insertDraft",
];

export function isInAppAction(value: unknown): value is InAppHotkeyAction {
  return (
    typeof value === "string" &&
    (IN_APP_ACTIONS as readonly string[]).includes(value)
  );
}

export type HotkeyProblem =
  /** Нажаты одни модификаторы — комбинации ещё нет. */
  | "modifier-only"
  /** Без Ctrl/Alt/Win комбинация перехватывала бы обычный ввод текста. */
  | "needs-modifier"
  /** Клавиша, которую система не отдаёт приложениям. */
  | "unsupported"
  /** Уже занята другой функцией самого приложения. */
  | "reserved"
  /** Занята другим приложением — выяснилось при попытке зарегистрировать. */
  | "taken";

interface KeyboardLike {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * Имя клавиши для Electron по физическому коду.
 *
 * Именно по коду, а не по `key`: на русской раскладке та же клавиша приезжает
 * как «р», и комбинация, записанная в одной раскладке, не работала бы в
 * другой.
 */
export function mainKeyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  const fn = /^F(\d{1,2})$/.exec(code);
  if (fn) return `F${fn[1]}`;
  const named: Record<string, string> = {
    Space: "Space",
    Tab: "Tab",
    Enter: "Return",
    NumpadEnter: "Return",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Minus: "-",
    Equal: "=",
    Backquote: "`",
  };
  return named[code] || null;
}

/** Собирает комбинацию из нажатия. null — нажаты одни модификаторы. */
export function acceleratorFromEvent(event: KeyboardLike): string | null {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  const main = mainKeyFromCode(event.code);
  if (!main) return null;
  parts.push(main);
  return parts.join("+");
}

/**
 * Проверяет комбинацию по всему, что можно проверить без обращения к системе:
 * форма и совпадение с нашими собственными хоткеями. Занятость другими
 * приложениями так не выясняется — для этого её нужно попробовать
 * зарегистрировать, см. главный процесс.
 */
export function checkHotkey(
  accelerator: string,
  /** Комбинации других действий приложения — они тоже заняты. */
  otherActions: readonly string[] = [],
): HotkeyProblem | null {
  const parts = accelerator
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return "modifier-only";

  const modifiers = new Set(["Control", "Alt", "Shift", "Super"]);
  const main = parts[parts.length - 1];
  if (modifiers.has(main)) return "modifier-only";

  const used = parts.slice(0, -1);
  if (used.length === 0) return "needs-modifier";
  // Один Shift не считается: Shift+буква — это обычный ввод заглавной.
  if (used.every((m) => m === "Shift")) return "needs-modifier";

  if (!mainKeyFromCodeAllowed(main)) return "unsupported";

  if (BUILTIN_HOTKEYS[accelerator]) return "reserved";
  if (otherActions.includes(accelerator)) return "reserved";
  return null;
}

function mainKeyFromCodeAllowed(main: string): boolean {
  if (/^[A-Z0-9]$/.test(main)) return true;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(main)) return true;
  return [
    "Space",
    "Tab",
    "Return",
    "Backspace",
    "Delete",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Up",
    "Down",
    "Left",
    "Right",
    ",",
    ".",
    "/",
    "\\",
    ";",
    "'",
    "[",
    "]",
    "-",
    "=",
    "`",
  ].includes(main);
}

/** Человекочитаемая запись комбинации для интерфейса. */
export function formatAccelerator(accelerator: string): string {
  return accelerator
    .split("+")
    .map((p) => (p === "Super" ? "Win" : p === "Control" ? "Ctrl" : p))
    .join(" + ");
}

/**
 * Совпадает ли нажатие с комбинацией.
 *
 * Сравнение идёт по физическому коду клавиши и набору модификаторов — так же,
 * как комбинация записывалась, поэтому раскладка ни на что не влияет.
 */
export function matchesAccelerator(
  event: KeyboardLike,
  accelerator: string,
  /** Shift разрешён сверх комбинации — им идёт обратный ход цикла. */
  allowExtraShift = false,
): boolean {
  const parts = accelerator
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  const main = parts[parts.length - 1];
  if (mainKeyFromCode(event.code) !== main) return false;

  const wanted = new Set(parts.slice(0, -1));
  if (event.ctrlKey !== wanted.has("Control")) return false;
  if (event.altKey !== wanted.has("Alt")) return false;
  if (event.metaKey !== wanted.has("Super")) return false;
  if (!allowExtraShift && event.shiftKey !== wanted.has("Shift")) return false;
  if (allowExtraShift && !event.shiftKey && wanted.has("Shift")) return false;
  return true;
}

/** Модификаторы комбинации — их отпускание завершает переключение. */
export function acceleratorModifiers(accelerator: string): string[] {
  const parts = accelerator
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.slice(0, -1).filter((p) => p !== "Shift");
}

/**
 * Проверка внутриоконной комбинации.
 *
 * Отличается от глобальной: система такие сочетания не видит, поэтому
 * занятость другими приложениями не проверяется — конфликтовать они могут
 * только с нашими собственными.
 */
export function checkInAppHotkey(
  accelerator: string,
  otherActions: readonly string[] = [],
): HotkeyProblem | null {
  return checkHotkey(accelerator, otherActions);
}
