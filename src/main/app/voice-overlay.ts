import { BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import { watchHotkeyRelease } from "../voice-sidecar";
import { readHotkeys, writeHotkeys } from "../hotkey-store";
import {
  checkHotkey,
  checkInAppHotkey,
  IN_APP_ACTIONS,
  isInAppAction,
  INSERT_DRAFT_DEFAULT,
  NEXT_CHAT_DEFAULT,
  PREV_CHAT_DEFAULT,
  SWITCH_CHAT_DEFAULT,
  VOICE_DICTATION_QUIET_DEFAULT,
  type GlobalHotkeyAction,
  type HotkeyProblem,
  type InAppHotkeyAction,
} from "../../shared/hotkeys";
import { captureRegion, captureScreen, type Screenshot } from "../screenshot";
import { refreshWindowHotkeys } from "./window-hotkeys";
import { is } from "@electron-toolkit/utils";
import { join } from "path";

// Быстрая диктовка по глобальной горячей клавише.
//
// Сценарий: приложение свёрнуто, человек зажимает комбинацию, говорит и
// отпускает — распознанный текст оказывается в поле ввода текущего чата, а
// окно приложения поднимается.
//
// Главное ограничение, вокруг которого построено всё остальное: Electron
// отдаёт только НАЖАТИЕ глобальной комбинации, отпускание он не видит.
// Поэтому запись останавливает не глобальный хоткей, а само окошко: оно
// всплывает сфокусированным, а внутри сфокусированного окна keyup — обычное
// событие клавиатуры. Если человек отпустил клавиши раньше, чем окно успело
// получить фокус, keyup не придёт вовсе — тогда работает откат на
// переключатель: повторное нажатие хоткея (или Escape) завершает запись.

/**
 * Комбинации для диктовки, в порядке предпочтения.
 *
 * Глобальный хоткей достаётся тому, кто зарегистрировал его первым: если
 * комбинацию уже занял кто-то другой (у Claude Desktop, например, на
 * Ctrl+Alt+Space висит быстрый ввод), `register` возвращает false и наша
 * регистрация тихо не делает ничего. Поэтому перебираем список и сообщаем в
 * лог, что в итоге заняли.
 */
const VOICE_HOTKEY_CANDIDATES = [
  "Control+Alt+H",
  "Control+Alt+D",
  "Control+Shift+F2",
];

/** То же, но для тихой диктовки — она окно не поднимает. */
const VOICE_QUIET_HOTKEY_CANDIDATES = [
  VOICE_DICTATION_QUIET_DEFAULT,
  "Control+Alt+K",
  "Control+Shift+F3",
];

function candidates(configured: string, fallbacks: string[]): string[] {
  return configured
    ? [configured, ...fallbacks.filter((k) => k !== configured)]
    : fallbacks;
}

/** Те комбинации, которые удалось занять; до регистрации — первые из списков. */
let activeHotkey = VOICE_HOTKEY_CANDIDATES[0];
let activeQuietHotkey = VOICE_QUIET_HOTKEY_CANDIDATES[0];
/**
 * Комбинация, которой начали текущую запись, и её режим.
 *
 * Диктовок две, а окошко одно: за отпусканием следят по той комбинации,
 * которую действительно зажали, а по режиму решают, поднимать ли окно.
 */
let dictationHotkey = VOICE_HOTKEY_CANDIDATES[0];
let dictationQuiet = false;
let activeScreenshotHotkey = "Control+Alt+S";
let activeRegionHotkey = "Control+Alt+A";

const OVERLAY_WIDTH = 380;
const OVERLAY_HEIGHT = 132;
/** Отступ от нижнего края экрана — окно висит над панелью задач. */
const OVERLAY_BOTTOM_MARGIN = 120;
/**
 * Сколько ждать команду «следи за комбинацией» от окошка, прежде чем считать,
 * что наблюдателя не будет. Без него отличить автоповтор от нового нажатия
 * нечем, и остаётся разрешить переключатель по времени.
 */
const WATCH_FALLBACK_MS = 3000;

const SCREENSHOT_HOTKEY_CANDIDATES = [
  "Control+Alt+S",
  "Control+Alt+P",
  "Control+Shift+F3",
];

const REGION_HOTKEY_CANDIDATES = [
  "Control+Alt+A",
  "Control+Alt+R",
  "Control+Shift+F4",
];

interface VoiceOverlayDeps {
  /** Поднять и сфокусировать основное окно после диктовки. */
  showMainWindow: () => void;
  /** Основное окно — туда уходит распознанный текст. */
  getMainWindow: () => BrowserWindow | null;
}

let overlay: BrowserWindow | null = null;
let deps: VoiceOverlayDeps | null = null;
/**
 * Момент, начиная с которого нажатие хоткея означает «закончить запись».
 *
 * Пока комбинация зажата, Windows шлёт событие хоткея снова и снова — это
 * обычный автоповтор, и отличить его от нового нажатия по времени нельзя:
 * удержание длится дольше любого порога. Зато это точно знает наблюдатель за
 * клавишами: он сообщает, что комбинацию отпустили. До его ответа все
 * повторы игнорируются.
 */
let toggleAllowedAt = Number.POSITIVE_INFINITY;
let watchStarted = false;
let watchFallbackTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Имена клавиш комбинации в терминах KeyboardEvent.key — окошко по ним
 * понимает, отпускание чего считать концом записи.
 */
/**
 * Виртуальные коды клавиш комбинации — по ним сайдкар спрашивает систему,
 * держат их ещё или уже отпустили.
 */
export function hotkeyVirtualKeys(accelerator: string): number[] {
  const vks: number[] = [];
  for (const raw of accelerator.split("+")) {
    const part = raw.trim().toLowerCase();
    if (!part) continue;
    if (part === "control" || part === "ctrl" || part === "commandorcontrol") {
      vks.push(0x11);
    } else if (part === "alt" || part === "option") {
      vks.push(0x12);
    } else if (part === "shift") {
      vks.push(0x10);
    } else if (part === "super" || part === "meta" || part === "command") {
      vks.push(0x5b);
    } else if (part === "space") {
      vks.push(0x20);
    } else if (part.length === 1 && /[a-z0-9]/.test(part)) {
      vks.push(part.toUpperCase().charCodeAt(0));
    }
    // Функциональные и прочие клавиши сознательно пропускаем: без них
    // наблюдатель просто не вооружится, и останется режим переключателя —
    // это лучше, чем следить не за тем.
  }
  return vks;
}

export function hotkeyEventCodes(accelerator: string): string[] {
  const codes: string[] = [];
  for (const raw of accelerator.split("+")) {
    const part = raw.trim();
    if (part.length !== 1) continue;
    if (/[a-z]/i.test(part)) codes.push(`Key${part.toUpperCase()}`);
    else if (/[0-9]/.test(part)) codes.push(`Digit${part}`);
  }
  return codes;
}

export function hotkeyEventKeys(accelerator: string): string[] {
  const keys: string[] = [];
  for (const raw of accelerator.split("+")) {
    const part = raw.trim().toLowerCase();
    if (!part) continue;
    if (part === "control" || part === "ctrl" || part === "commandorcontrol") {
      keys.push("Control");
    } else if (part === "alt" || part === "option") {
      keys.push("Alt");
    } else if (part === "shift") {
      keys.push("Shift");
    } else if (part === "super" || part === "meta" || part === "command") {
      keys.push("Meta");
    } else if (part === "space") {
      keys.push(" ");
    } else if (part.length === 1) {
      keys.push(part);
    } else {
      keys.push(raw.trim());
    }
  }
  return keys;
}

/** Положение окошка: по центру внизу того экрана, где сейчас курсор. */
export function overlayBounds(
  workArea: { x: number; y: number; width: number; height: number },
  width = OVERLAY_WIDTH,
  height = OVERLAY_HEIGHT,
  bottomMargin = OVERLAY_BOTTOM_MARGIN,
): { x: number; y: number; width: number; height: number } {
  return {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - bottomMargin),
  };
}

function ensureOverlay(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) return overlay;

  overlay = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Окно должно перекрывать даже полноэкранные приложения: диктовка
    // вызывается поверх чего угодно.
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const rendererHtmlPath = join(__dirname, "../renderer/index.html");
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void overlay.loadURL(
      `${process.env["ELECTRON_RENDERER_URL"]}#voice-overlay`,
    );
  } else {
    void overlay.loadFile(rendererHtmlPath, { hash: "voice-overlay" });
  }

  // Окошко живёт в отдельном окне, и его консоль иначе видна только в
  // DevTools — а открыть их поверх всплывающей плашки нереально. Поэтому
  // пересылаем её в общий лог приложения.
  overlay.webContents.on("console-message", (details) => {
    console.log("[overlay]", details.message);
  });

  overlay.on("closed", () => {
    overlay = null;
  });
  return overlay;
}

function isOverlayVisible(): boolean {
  return !!overlay && !overlay.isDestroyed() && overlay.isVisible();
}

function showOverlay(): void {
  const win = ensureOverlay();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  win.setBounds(overlayBounds(display.workArea));
  win.showInactive();
  // Фокус — обязательное условие: без него окно не получит keyup, и запись
  // нечем будет остановить, кроме повторного нажатия хоткея.
  win.focus();
  toggleAllowedAt = Number.POSITIVE_INFINITY;
  watchStarted = false;
  if (watchFallbackTimer) clearTimeout(watchFallbackTimer);
  watchFallbackTimer = setTimeout(() => {
    // Окошко так и не попросило следить за клавишами — наблюдателя не будет,
    // значит завершать придётся повторным нажатием, как раньше.
    if (!watchStarted) toggleAllowedAt = Date.now();
  }, WATCH_FALLBACK_MS);
  win.webContents.send("voice-dictation-begin", {
    keys: hotkeyEventKeys(dictationHotkey),
    // Буквенная клавиша в KeyboardEvent.key зависит от раскладки: при русской
    // «H» приезжает как «р». Физический код от раскладки не зависит.
    codes: hotkeyEventCodes(dictationHotkey),
    hotkey: dictationHotkey,
    quiet: dictationQuiet,
  });
}

function hideOverlay(): void {
  if (overlay && !overlay.isDestroyed() && overlay.isVisible()) overlay.hide();
}

/**
 * Снимок экрана по глобальной комбинации: кадр снимается, окно приложения
 * поднимается, картинка попадает в карточку предпросмотра.
 */
async function onScreenshotHotkey(): Promise<void> {
  await captureAndStage(() => captureScreen(deps?.getMainWindow() ?? null));
}

/**
 * «Ножницы» по глобальной комбинации: поверх замороженного кадра открывается
 * выделение области, и в чат уходит только выбранный прямоугольник. Отказ от
 * выделения ничего не прикрепляет и окно не поднимает — человек передумал.
 */
async function onRegionHotkey(): Promise<void> {
  await captureAndStage(() => captureRegion(deps?.getMainWindow() ?? null));
}

/**
 * Снимок не прикрепляется к чату сразу, а задерживается в карточке
 * предпросмотра внутри основного окна.
 *
 * Комбинация глобальная: её нажимают, глядя в чужое окно, и какой диалог в
 * этот момент открыт — чистая случайность. Раньше снимок уезжал именно в
 * него, и промах стоил повторного снимка. Теперь кадр ждёт, пока человек
 * выберет диалог, а окно поднимается, чтобы выбирать было где.
 */
async function captureAndStage(
  capture: () => Promise<Screenshot | null>,
): Promise<void> {
  let shot: Screenshot | null;
  try {
    shot = await capture();
  } catch (err) {
    console.warn("[HOTKEY] screenshot failed:", err);
    return;
  }
  if (!shot) return;
  deps?.showMainWindow();
  deps?.getMainWindow()?.webContents.send("screenshot-captured", {
    png: shot.png,
    name: shot.name,
  });
}

function registerScreenshotHotkey(accelerator: string): boolean {
  try {
    if (!globalShortcut.register(accelerator, () => void onScreenshotHotkey()))
      return false;
  } catch (err) {
    console.warn("[HOTKEY] register error", accelerator, err);
    return false;
  }
  activeScreenshotHotkey = accelerator;
  return true;
}

function registerRegionHotkey(accelerator: string): boolean {
  try {
    if (!globalShortcut.register(accelerator, () => void onRegionHotkey()))
      return false;
  } catch (err) {
    console.warn("[HOTKEY] register error", accelerator, err);
    return false;
  }
  activeRegionHotkey = accelerator;
  return true;
}

/**
 * Обработчик нажатия комбинации диктовки.
 *
 * `quiet` решает только одно — поднимать ли окно приложения после записи.
 * Сама запись и распознавание в обоих режимах одинаковые.
 */
function onHotkey(accelerator: string, quiet: boolean): void {
  if (isOverlayVisible()) {
    // Автоповтор зажатой комбинации — не команда «закончить».
    if (Date.now() < toggleAllowedAt) return;
    // Откат на переключатель: удержание не отследилось, значит остановить
    // запись можно только повторным нажатием.
    overlay?.webContents.send("voice-dictation-finish");
    return;
  }
  dictationHotkey = accelerator;
  dictationQuiet = quiet;
  showOverlay();
}

/** Пытается занять комбинацию. false — её уже держит кто-то другой. */
function registerVoiceHotkey(accelerator: string): boolean {
  try {
    if (
      !globalShortcut.register(accelerator, () => onHotkey(accelerator, false))
    )
      return false;
  } catch (err) {
    console.warn("[HOTKEY] register error", accelerator, err);
    return false;
  }
  activeHotkey = accelerator;
  return true;
}

function registerQuietVoiceHotkey(accelerator: string): boolean {
  try {
    if (
      !globalShortcut.register(accelerator, () => onHotkey(accelerator, true))
    )
      return false;
  } catch (err) {
    console.warn("[HOTKEY] register error", accelerator, err);
    return false;
  }
  activeQuietHotkey = accelerator;
  return true;
}

/**
 * Свободна ли комбинация в системе.
 *
 * Узнать это можно единственным способом — попробовать её занять: Windows не
 * умеет отвечать, кто держит комбинацию, она лишь отказывает в регистрации.
 * Поэтому текущую комбинацию на время проверки приходится отпускать, а потом
 * возвращать. Ответ верен на момент проверки: приложение, запущенное позже,
 * может перехватить её первым.
 *
 * Есть и то, чего эта проверка не видит: программы вроде переключателей
 * раскладки ловят клавиши низкоуровневым хуком, не регистрируя комбинацию, —
 * система о них не знает, и мы тоже.
 */
export function probeHotkeyAvailable(accelerator: string): boolean {
  // Освобождаем обе свои комбинации: проверяемая может совпасть с любой из
  // них, и тогда система откажет нам же.
  const mine: [string, (a: string) => boolean][] = [
    [activeHotkey, registerVoiceHotkey],
    [activeQuietHotkey, registerQuietVoiceHotkey],
    [activeScreenshotHotkey, registerScreenshotHotkey],
    [activeRegionHotkey, registerRegionHotkey],
  ];
  const held = mine.filter(([a]) => globalShortcut.isRegistered(a));
  for (const [a] of held) globalShortcut.unregister(a);

  let free = false;
  try {
    free = globalShortcut.register(accelerator, () => undefined);
  } catch {
    free = false;
  }
  if (free) globalShortcut.unregister(accelerator);

  // Вернуть как было: проверка не должна стоить пользователю рабочего хоткея.
  for (const [a, register] of held) {
    if (!globalShortcut.isRegistered(a)) register(a);
  }
  return free;
}

/**
 * Регистрирует горячую клавишу и обработчики окошка. Вызывается один раз при
 * старте приложения; окно создаётся заранее и скрыто, чтобы первое нажатие не
 * ждало загрузки рендерера.
 */
export function setupVoiceDictation(d: VoiceOverlayDeps): void {
  deps = d;

  /** Внутриоконные комбинации — из файла, с подстановкой значений по умолчанию. */
  const inAppHotkeys = (): Record<InAppHotkeyAction, string> => {
    const stored = readHotkeys();
    return {
      switchChat: stored.switchChat || SWITCH_CHAT_DEFAULT,
      nextChat: stored.nextChat || NEXT_CHAT_DEFAULT,
      prevChat: stored.prevChat || PREV_CHAT_DEFAULT,
      insertDraft: stored.insertDraft || INSERT_DRAFT_DEFAULT,
    };
  };

  ipcMain.handle("hotkeys-get", () => ({
    voiceDictation: activeHotkey,
    voiceDictationQuiet: activeQuietHotkey,
    screenshot: activeScreenshotHotkey,
    region: activeRegionHotkey,
    ...inAppHotkeys(),
  }));

  /**
   * Внутриоконная комбинация: система её не видит, поэтому занимать ничего не
   * нужно — достаточно проверить форму и не дать совпасть с нашими же.
   */
  ipcMain.handle(
    "hotkeys-set-in-app",
    (
      _event,
      action: unknown,
      accelerator: unknown,
    ): { ok: boolean; problem?: HotkeyProblem } => {
      if (!isInAppAction(action)) return { ok: false, problem: "unsupported" };
      const value = typeof accelerator === "string" ? accelerator.trim() : "";
      const current = inAppHotkeys();
      // Заняты и глобальные наши, и остальные внутриоконные: перехватывать
      // собственную комбинацию дважды нельзя.
      const others = [
        activeHotkey,
        activeQuietHotkey,
        activeScreenshotHotkey,
        activeRegionHotkey,
        ...IN_APP_ACTIONS.filter((a) => a !== action).map((a) => current[a]),
      ];
      const problem = checkInAppHotkey(value, others);
      if (problem) return { ok: false, problem };
      writeHotkeys({
        voiceDictation: activeHotkey,
        voiceDictationQuiet: activeQuietHotkey,
        screenshot: activeScreenshotHotkey,
        region: activeRegionHotkey,
        ...current,
        [action]: value,
      });
      // Часть внутриоконных комбинаций перехватывает главный процесс — ему
      // нужно узнать новую сразу, а не при следующем запуске.
      refreshWindowHotkeys();
      return { ok: true };
    },
  );

  // Проверка без сохранения: интерфейс спрашивает, годится ли комбинация, и
  // только потом предлагает применить.
  ipcMain.handle(
    "hotkeys-check",
    (
      _event,
      accelerator: unknown,
    ): { ok: boolean; problem?: HotkeyProblem } => {
      const value = typeof accelerator === "string" ? accelerator.trim() : "";
      const problem = checkHotkey(value);
      if (problem) return { ok: false, problem };
      if (
        value === activeHotkey ||
        value === activeQuietHotkey ||
        value === activeScreenshotHotkey ||
        value === activeRegionHotkey
      ) {
        return { ok: true };
      }
      if (!probeHotkeyAvailable(value)) return { ok: false, problem: "taken" };
      return { ok: true };
    },
  );

  /**
   * Смена комбинации. Сначала проверка формы и своих же комбинаций, потом
   * попытка занять — узнать, свободна ли она в системе, можно только так.
   * Не вышло — возвращаем прежнюю: действие не должно остаться совсем без
   * рабочей комбинации.
   */
  const changeHotkey = (
    accelerator: unknown,
    action: GlobalHotkeyAction,
  ): { ok: boolean; problem?: HotkeyProblem } => {
    const value = typeof accelerator === "string" ? accelerator.trim() : "";
    // Только глобальные: внутриоконную комбинацию система не регистрирует,
    // у неё свой обработчик выше.
    const registrars: Record<
      GlobalHotkeyAction,
      { current: () => string; register: (a: string) => boolean }
    > = {
      voiceDictation: {
        current: () => activeHotkey,
        register: registerVoiceHotkey,
      },
      voiceDictationQuiet: {
        current: () => activeQuietHotkey,
        register: registerQuietVoiceHotkey,
      },
      screenshot: {
        current: () => activeScreenshotHotkey,
        register: registerScreenshotHotkey,
      },
      region: {
        current: () => activeRegionHotkey,
        register: registerRegionHotkey,
      },
    };
    const inApp = inAppHotkeys();
    const others = (Object.keys(registrars) as GlobalHotkeyAction[])
      .filter((a) => a !== action)
      .map((a) => registrars[a].current())
      .concat(IN_APP_ACTIONS.map((a) => inApp[a]));
    const problem = checkHotkey(value, others);
    if (problem) return { ok: false, problem };

    const previous = registrars[action].current();
    const register = registrars[action].register;

    if (value !== previous) {
      globalShortcut.unregister(previous);
      if (!register(value)) {
        register(previous);
        return { ok: false, problem: "taken" };
      }
    }
    writeHotkeys({
      voiceDictation: activeHotkey,
      voiceDictationQuiet: activeQuietHotkey,
      screenshot: activeScreenshotHotkey,
      region: activeRegionHotkey,
      ...inAppHotkeys(),
    });
    console.log(`[HOTKEY] ${action} changed to`, value);
    return { ok: true };
  };

  ipcMain.handle("hotkeys-set-voice", (_event, accelerator: unknown) =>
    changeHotkey(accelerator, "voiceDictation"),
  );

  ipcMain.handle("hotkeys-set-voice-quiet", (_event, accelerator: unknown) =>
    changeHotkey(accelerator, "voiceDictationQuiet"),
  );

  ipcMain.handle("hotkeys-set-screenshot", (_event, accelerator: unknown) =>
    changeHotkey(accelerator, "screenshot"),
  );

  ipcMain.handle("hotkeys-set-region", (_event, accelerator: unknown) =>
    changeHotkey(accelerator, "region"),
  );

  ipcMain.handle("voice-dictation-commit", (_event, text: unknown) => {
    // В тихом режиме окошко закрывает себя само — после того как покажет,
    // что заметка готова и ждёт в приложении.
    if (!dictationQuiet) hideOverlay();
    const value = typeof text === "string" ? text.trim() : "";
    console.log("[HOTKEY] dictation commit, characters:", value.length);
    // Событие уходит всегда, даже с пустым текстом: им же снимается пометка
    // «распознаётся», иначе строка в карточке застрянет в этом состоянии.
    deps?.getMainWindow()?.webContents.send("voice-dictation-text", value);
    if (!value) return false;
    // В тихом режиме окно не поднимаем: заметка подождёт, пока человек сам
    // вернётся в приложение.
    if (!dictationQuiet) deps?.showMainWindow();
    return true;
  });

  // Удержание: окно сообщает, что запись пошла, и мы просим сайдкар следить
  // за комбинацией. Ответ приходит один раз — когда её отпустили или когда
  // стало ясно, что зажать не успели.
  ipcMain.handle("voice-dictation-watch", async () => {
    watchStarted = true;
    if (watchFallbackTimer) {
      clearTimeout(watchFallbackTimer);
      watchFallbackTimer = null;
    }
    // Именно та комбинация, которой начали запись: диктовок две, и следить
    // за чужой — значит получить «отпущено» сразу же, ведь её и не держали.
    const vks = hotkeyVirtualKeys(dictationHotkey);
    console.log("[HOTKEY] watching for release of", dictationHotkey, vks);
    const result = await watchHotkeyRelease(vks);
    console.log(
      "[HOTKEY] watch result:",
      result,
      "overlay visible:",
      isOverlayVisible(),
    );
    // Что бы наблюдатель ни ответил, клавиши уже не зажаты: дальше нажатие
    // хоткея — это новое нажатие, а не автоповтор.
    toggleAllowedAt = Date.now();
    if (result === "released" && isOverlayVisible()) {
      overlay?.webContents.send("voice-dictation-finish");
    }
    return result;
  });

  /**
   * Запись окончена, началось распознавание.
   *
   * Карточка черновиков сразу заводит строку с пометкой «распознаётся» —
   * иначе между отпусканием клавиш и приходом текста человек видит пустоту и
   * не понимает, записалось ли что-нибудь. Окно поднимаем только в обычном
   * режиме: тихая диктовка на то и тихая, чтобы не лезть на передний план
   * посреди чужой работы.
   */
  ipcMain.handle("voice-dictation-handoff", () => {
    deps?.getMainWindow()?.webContents.send("voice-dictation-pending");
    if (dictationQuiet) return true;
    hideOverlay();
    deps?.showMainWindow();
    return true;
  });

  /** Закрыть окошко, ничего не сообщая: тихий режим досказал своё сам. */
  ipcMain.handle("voice-dictation-close", () => {
    hideOverlay();
    return true;
  });

  // Ошибку распознавания показать больше негде — плашка к этому моменту уже
  // скрыта, поэтому на пару секунд возвращаем её.
  ipcMain.handle("voice-dictation-error", () => {
    if (overlay && !overlay.isDestroyed()) overlay.showInactive();
    return true;
  });

  ipcMain.handle("voice-dictation-cancel", () => {
    hideOverlay();
    // Отмена — не пустое распознавание: строку в карточке нужно убрать
    // целиком, а не превращать в «ничего не распознано».
    deps?.getMainWindow()?.webContents.send("voice-dictation-dropped");
    return true;
  });

  const stored = readHotkeys();

  let registered: string | null = null;
  for (const candidate of candidates(
    stored.voiceDictation,
    VOICE_HOTKEY_CANDIDATES,
  )) {
    if (registerVoiceHotkey(candidate)) {
      registered = candidate;
      break;
    }
    console.warn("[HOTKEY] already taken by another app:", candidate);
  }
  if (registered) {
    console.log("[HOTKEY] voice dictation:", registered);
  } else {
    console.warn(
      "[HOTKEY] no voice dictation hotkey could be registered; pick another one in settings",
    );
  }

  let quiet: string | null = null;
  for (const candidate of candidates(
    stored.voiceDictationQuiet,
    VOICE_QUIET_HOTKEY_CANDIDATES,
  )) {
    if (candidate === activeHotkey) continue;
    if (registerQuietVoiceHotkey(candidate)) {
      quiet = candidate;
      break;
    }
    console.warn("[HOTKEY] already taken by another app:", candidate);
  }
  if (quiet) console.log("[HOTKEY] quiet voice dictation:", quiet);
  else
    console.warn(
      "[HOTKEY] no quiet dictation hotkey could be registered; pick another one in settings",
    );

  let shot: string | null = null;
  for (const candidate of candidates(
    stored.screenshot,
    SCREENSHOT_HOTKEY_CANDIDATES,
  )) {
    if (candidate === activeHotkey || candidate === activeQuietHotkey) continue;
    if (registerScreenshotHotkey(candidate)) {
      shot = candidate;
      break;
    }
    console.warn("[HOTKEY] already taken by another app:", candidate);
  }
  if (shot) console.log("[HOTKEY] screenshot:", shot);
  else
    console.warn(
      "[HOTKEY] no screenshot hotkey could be registered; pick another one in settings",
    );

  let region: string | null = null;
  for (const candidate of candidates(stored.region, REGION_HOTKEY_CANDIDATES)) {
    if (
      candidate === activeHotkey ||
      candidate === activeQuietHotkey ||
      candidate === activeScreenshotHotkey
    )
      continue;
    if (registerRegionHotkey(candidate)) {
      region = candidate;
      break;
    }
    console.warn("[HOTKEY] already taken by another app:", candidate);
  }
  if (region) console.log("[HOTKEY] region capture:", region);
  else
    console.warn(
      "[HOTKEY] no region hotkey could be registered; pick another one in settings",
    );

  // Окно создаётся заранее и остаётся скрытым — первое нажатие хоткея должно
  // показывать готовое окно, а не ждать загрузки рендерера.
  ensureOverlay();
}

/** Закрывает окошко диктовки (выход из приложения). */
export function destroyVoiceDictation(): void {
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  overlay = null;
}
