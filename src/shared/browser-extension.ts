/** Общие типы проверки корпоративного расширения браузера (main ↔ renderer). */
export type BrowserId = "chrome" | "yandex";
export type ExtensionStatus = "installed" | "disabled" | "missing";

export interface BrowserExtensionInfo {
  browser: BrowserId;
  profile: string;
  status: ExtensionStatus;
}

export interface BrowserExtensionStatus {
  /** Напоминания включены в Настройках. */
  remind: boolean;
  /** Установленные браузеры и состояние расширения в них. */
  browsers: BrowserExtensionInfo[];
  /** О каких браузерах напомнить сейчас (с учётом «Позже» и настройки). */
  toRemind: BrowserExtensionInfo[];
}
