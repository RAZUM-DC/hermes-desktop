import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../useI18n";

/**
 * Запуск приложения вместе с системой.
 *
 * Отдельный раздел, а не галочка во «Внешнем виде»: это не оформление, а
 * поведение, и рядом со временем будет что добавить.
 *
 * Состояние читаем у системы при каждом открытии, а не храним у себя. Человек
 * мог убрать приложение из автозагрузки диспетчером задач Windows — тогда
 * наша галочка показывала бы включённым то, чего уже нет.
 */
export default function StartupPane(): React.JSX.Element {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.hermesAPI
      .autostartGet()
      .then((s) => {
        if (!alive) return;
        setEnabled(s.enabled);
        setSupported(s.supported);
      })
      .catch(() => {
        if (alive) setSupported(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = useCallback(async (): Promise<void> => {
    if (busy || !supported) return;
    setBusy(true);
    try {
      // Показываем то, что получилось, а не то, что просили: запись в
      // автозагрузку может не пройти — скажем, её запрещает политика.
      setEnabled(await window.hermesAPI.autostartSet(!enabled));
    } finally {
      setBusy(false);
    }
  }, [busy, enabled, supported]);

  return (
    <div className="settings-modal-pane">
      <div className="settings-field">
        <div className="settings-theme-system">
          <div>
            <div className="settings-theme-system-label">
              {t("settings.autostart.label")}
            </div>
            <div className="settings-theme-system-hint">
              {t("settings.autostart.hint")}
            </div>
          </div>
          <label className="tools-toggle" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy || !supported}
              onChange={() => void toggle()}
            />
            <span className="tools-toggle-track" />
          </label>
        </div>
        {!supported && (
          <div className="settings-field-hint">
            {t("settings.autostart.unsupported")}
          </div>
        )}
      </div>
      <div className="settings-field">
        <div className="settings-field-hint">
          {t("settings.autostart.trayNote")}
        </div>
      </div>
    </div>
  );
}
