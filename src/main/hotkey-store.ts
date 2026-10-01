import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import {
  INSERT_DRAFT_DEFAULT,
  NEXT_CHAT_DEFAULT,
  PREV_CHAT_DEFAULT,
  REGION_DEFAULT,
  SWITCH_CHAT_DEFAULT,
  SCREENSHOT_DEFAULT,
  VOICE_DICTATION_DEFAULT,
  VOICE_DICTATION_QUIET_DEFAULT,
} from "../shared/hotkeys";

/**
 * Настроенные пользователем горячие клавиши.
 *
 * Отдельный маленький файл рядом с остальными данными приложения, а не база:
 * читать его нужно на самом старте, ещё до того, как что-либо поднялось, и
 * терять настройку из-за недоступной базы было бы обидно.
 */

export interface HotkeySettings {
  voiceDictation: string;
  /** Диктовка, которая не поднимает окно: заметка просто ждёт в карточке. */
  voiceDictationQuiet: string;
  screenshot: string;
  region: string;
  /** Внутриоконная: панель недавних диалогов из сайдбара. */
  switchChat: string;
  /** Внутриоконная: следующая вкладка в верхней строке. */
  nextChat: string;
  /** Внутриоконная: предыдущая вкладка. */
  prevChat: string;
  /** Внутриоконная: вставить последний черновик в открытый диалог. */
  insertDraft: string;
}

function hotkeysPath(): string {
  return join(app.getPath("userData"), "hotkeys.json");
}

export function readHotkeys(): HotkeySettings {
  // Переменные окружения остаются: ими удобно проверять сборку, не трогая
  // сохранённые настройки.
  const fallback: HotkeySettings = {
    voiceDictation:
      process.env.HERMES_DESKTOP_VOICE_HOTKEY?.trim() ||
      VOICE_DICTATION_DEFAULT,
    voiceDictationQuiet:
      process.env.HERMES_DESKTOP_VOICE_QUIET_HOTKEY?.trim() ||
      VOICE_DICTATION_QUIET_DEFAULT,
    screenshot:
      process.env.HERMES_DESKTOP_SCREENSHOT_HOTKEY?.trim() ||
      SCREENSHOT_DEFAULT,
    region: process.env.HERMES_DESKTOP_REGION_HOTKEY?.trim() || REGION_DEFAULT,
    switchChat: SWITCH_CHAT_DEFAULT,
    nextChat: NEXT_CHAT_DEFAULT,
    prevChat: PREV_CHAT_DEFAULT,
    insertDraft: INSERT_DRAFT_DEFAULT,
  };
  const file = hotkeysPath();
  if (!existsSync(file)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<
      Record<keyof HotkeySettings, unknown>
    >;
    const pick = (key: keyof HotkeySettings): string => {
      const value = parsed[key];
      const stored = typeof value === "string" ? value.trim() : "";
      return stored || fallback[key];
    };
    const legacy = (key: string): string => {
      const value = (parsed as Record<string, unknown>)[key];
      return typeof value === "string" ? value.trim() : "";
    };
    return {
      voiceDictation: pick("voiceDictation"),
      voiceDictationQuiet: pick("voiceDictationQuiet"),
      screenshot: pick("screenshot"),
      region: pick("region"),
      switchChat: pick("switchChat"),
      nextChat: pick("nextChat"),
      prevChat: pick("prevChat"),
      // Действие переименовано: раньше оно вставляло только снимок. Старое
      // имя читаем как запасное, чтобы настройка не сбросилась молча.
      insertDraft:
        pick("insertDraft") === INSERT_DRAFT_DEFAULT
          ? legacy("insertScreenshot") || INSERT_DRAFT_DEFAULT
          : pick("insertDraft"),
    };
  } catch {
    return fallback;
  }
}

export function writeHotkeys(settings: HotkeySettings): void {
  const file = hotkeysPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}
