import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserExtensionInfo,
  BrowserId,
} from "../../../shared/browser-extension";
import { useI18n } from "./useI18n";

// Проверка дешёвая (чтение файлов профиля), но не чаще раза в минуту — при
// каждом возврате фокуса окна. Так плашка пропадает сама, когда человек
// поставил расширение в браузере и вернулся в приложение.
const RECHECK_MIN_MS = 60_000;
const DAILY_MS = 24 * 60 * 60 * 1000;

/**
 * Плашка «поставьте корпоративное расширение РАЗУМ ИИ-помощник» для Chrome и
 * Яндекс.Браузера, если его там нет или оно выключено. «Установить» открывает
 * страницу расширения в магазине именно в этом браузере; «Позже» — неделя
 * тишины; «Не напоминать» — выключает напоминания (вернуть — в Настройках →
 * Запуск).
 */
export function BrowserExtensionBanner(): React.JSX.Element | null {
  const { t } = useI18n();
  const [items, setItems] = useState<BrowserExtensionInfo[]>([]);
  const lastCheck = useRef(0);

  const refresh = useCallback(async (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastCheck.current < RECHECK_MIN_MS) return;
    lastCheck.current = now;
    try {
      const s = await window.hermesAPI.browserExtensionStatus();
      setItems(s.toRemind);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void refresh(true), DAILY_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [refresh]);

  if (items.length === 0) return null;

  const name = (b: BrowserId): string =>
    t(
      b === "chrome"
        ? "settings.browserExtension.chrome"
        : "settings.browserExtension.yandex",
    );
  const anyMissing = items.some((i) => i.status === "missing");
  const browsers = items
    .map((i) => name(i.browser))
    .join(t("settings.browserExtension.and"));

  return (
    <div className="verify-warning-banner" role="status">
      <span className="verify-warning-text">
        {t(
          anyMissing
            ? "settings.browserExtension.bannerMissing"
            : "settings.browserExtension.bannerDisabled",
          { browsers },
        )}
      </span>
      <div className="verify-warning-actions">
        {items.map((i) => (
          <button
            key={i.browser}
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => {
              void window.hermesAPI.browserExtensionOpenStore(i.browser);
              lastCheck.current = 0; // перепроверить при возврате фокуса
            }}
          >
            {t(
              i.status === "missing"
                ? "settings.browserExtension.install"
                : "settings.browserExtension.open",
              { browser: name(i.browser) },
            )}
          </button>
        ))}
        <button
          className="btn-ghost btn-sm"
          type="button"
          onClick={() => {
            void window.hermesAPI.browserExtensionSnooze();
            setItems([]);
          }}
        >
          {t("settings.browserExtension.later")}
        </button>
        <button
          className="btn-ghost btn-sm"
          type="button"
          onClick={() => {
            void window.hermesAPI.browserExtensionSetRemind(false);
            setItems([]);
          }}
        >
          {t("settings.browserExtension.never")}
        </button>
      </div>
    </div>
  );
}

export default BrowserExtensionBanner;
