import { useCallback, useEffect, useState } from "react";
import { Refresh } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";
import type { MemoryFact } from "../../../../shared/memory-bank";

/**
 * Личный банк памяти в гибридном режиме.
 *
 * Здесь показано то, что ассистент помнит о человеке между разговорами, и
 * отсюда же можно добавить факт руками. Раньше на этом месте стояла заглушка
 * «недоступно в удалённом режиме», хотя банк давно существует и наполняется:
 * путь до него был построен целиком, приложение им просто не пользовалось.
 *
 * Экран только показывает. Ни записи, ни удаления здесь нет, и это не
 * забывчивость:
 *
 *   удаление — identity-proxy режет его по самому маршруту, по слову в пути,
 *              а не по правам;
 *   запись   — выключена на сервере флагом MEMORY_ALLOW_RETAIN=false, и это
 *              осознанное решение после разбора безопасности (red-team P6):
 *              защищались как раз от того, чтобы агент не дописывал себе
 *              долговременную память по ходу разговора.
 *
 * Обе кнопки вернули бы 403 при любом раскладе, поэтому их нет, а причина
 * написана прямо на экране — чтобы человек не искал их и не считал, что они
 * где-то спрятаны.
 */

function factDate(at: number, locale: string): string {
  if (!at) return "";
  return new Date(at).toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function MemoryBank(): React.JSX.Element {
  const { t, locale } = useI18n();
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const page = await window.hermesAPI.memoryBankList(100, 0);
      setFacts(page.items);
      setTotal(page.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const errorText = (code: string): string => {
    if (code === "forbidden") return t("memory.bankForbidden");
    if (code === "unauthorized") return t("memory.bankUnauthorized");
    if (code === "unavailable") return t("memory.bankUnavailable");
    return code;
  };

  return (
    <div className="settings-container">
      <div className="memory-header">
        <div>
          <h1 className="settings-header" style={{ marginBottom: 4 }}>
            {t("memory.title")}
          </h1>
          <p className="memory-subtitle">{t("memory.bankSubtitle")}</p>
        </div>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => void load()}
          disabled={loading}
          title={t("common.refresh")}
        >
          <Refresh size={13} />
        </button>
      </div>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <div className="loading-spinner" />
        </div>
      ) : error ? (
        <div className="settings-error" role="alert">
          {errorText(error)}
        </div>
      ) : facts.length === 0 ? (
        <p className="memory-subtitle">{t("memory.bankEmpty")}</p>
      ) : (
        <>
          <p className="memory-subtitle">
            {t("memory.bankCount", { count: total })}
          </p>
          <ul className="memory-bank-list">
            {facts.map((f, i) => (
              <li key={f.id || `${i}-${f.text.slice(0, 24)}`}>
                <span className="memory-bank-text">{f.text}</span>
                <span className="memory-bank-meta">
                  {factDate(f.at, locale)}
                  {f.tags.length > 0 && ` · ${f.tags.join(", ")}`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="settings-field-hint">{t("memory.bankReadOnly")}</p>
    </div>
  );
}

export default MemoryBank;
