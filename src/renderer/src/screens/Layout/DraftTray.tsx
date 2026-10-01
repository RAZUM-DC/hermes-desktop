import { useState } from "react";
import {
  Camera,
  CornerDownLeft,
  Loader,
  Mic,
  Paperclip,
  Trash,
  X,
} from "lucide-react";
import { useI18n } from "../../components/useI18n";
import { ImagePreview } from "../../components/ImagePreview";
import {
  draftLabel,
  isInsertable,
  type ImageDraft,
  type PendingDraft,
} from "./draftStack";

interface DraftTrayProps {
  drafts: PendingDraft[];
  /** Комбинация быстрой вставки — показываем подсказкой. */
  insertHotkey: string;
  /** Почему вставка не удалась, если не удалась. */
  error: string | null;
  onInsert: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}

/**
 * Карточка черновиков — снимков и голосовых заметок, ожидающих диалога.
 *
 * Живёт в Layout, а не в чате, и это главное в ней: она обязана пережить
 * смену диалога — ради этого всё и затевалось. Внутри чата она пряталась бы
 * вместе с ним (вкладки у нас скрываются через display: none).
 *
 * Фокус карточка не забирает: `onMouseDown` с preventDefault оставляет
 * каретку в поле ввода, поэтому после вставки можно сразу продолжать печатать,
 * а комбинации переключения диалогов продолжают работать.
 */
export function DraftTray({
  drafts,
  insertHotkey,
  error,
  onInsert,
  onRemove,
  onClear,
}: DraftTrayProps): React.JSX.Element | null {
  const { t, locale } = useI18n();
  const [preview, setPreview] = useState<ImageDraft | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (drafts.length === 0) return null;

  const keepFocus = (event: React.MouseEvent): void => event.preventDefault();

  /** Что показать вместо текста, пока его нет. */
  const noteText = (draft: PendingDraft): string => {
    if (draft.kind !== "text") return "";
    if (draft.state === "recognizing") return t("chat.drafts.recognizing");
    if (draft.state === "empty") return t("chat.drafts.nothingHeard");
    return draft.text;
  };

  return (
    <>
      <div
        className="draft-tray"
        role="region"
        aria-label={t("chat.drafts.title")}
      >
        <div className="draft-tray-header">
          <span className="draft-tray-title">{t("chat.drafts.title")}</span>
          <span className="draft-tray-count">{drafts.length}</span>
          <button
            type="button"
            className="draft-tray-clear"
            title={t("chat.drafts.clearAll")}
            aria-label={t("chat.drafts.clearAll")}
            onMouseDown={keepFocus}
            onClick={onClear}
          >
            <X size={14} />
          </button>
        </div>

        <div className="draft-tray-list">
          {drafts.map((draft) => (
            <div className="draft-tray-item" key={draft.id}>
              {draft.kind === "image" ? (
                <button
                  type="button"
                  className="draft-tray-thumb"
                  title={t("chat.drafts.open")}
                  onMouseDown={keepFocus}
                  onClick={() => setPreview(draft)}
                >
                  <img src={draft.url} alt={draft.name} />
                </button>
              ) : draft.kind === "file" ? (
                <span className="draft-tray-icon" aria-hidden="true">
                  <Paperclip size={14} />
                </span>
              ) : (
                <span className="draft-tray-icon" aria-hidden="true">
                  {draft.state === "recognizing" ? (
                    <Loader className="draft-tray-spinner" size={14} />
                  ) : (
                    <Mic size={14} />
                  )}
                </span>
              )}

              <div className="draft-tray-body">
                {draft.kind === "text" ? (
                  <button
                    type="button"
                    className={`draft-tray-note${
                      draft.state === "ready" ? "" : " draft-tray-note--muted"
                    }`}
                    title={t("chat.drafts.open")}
                    onMouseDown={keepFocus}
                    onClick={() =>
                      setExpanded((prev) =>
                        prev === draft.id ? null : draft.id,
                      )
                    }
                  >
                    <span
                      className={
                        expanded === draft.id ? undefined : "draft-tray-clamp"
                      }
                    >
                      {noteText(draft)}
                    </span>
                  </button>
                ) : draft.kind === "file" ? (
                  // Имя файла, а не «вложение»: человек прикладывал его к
                  // заметке под этим именем и по нему его и узнаёт.
                  <span className="draft-tray-shot" title={draft.name}>
                    {draft.name}
                  </span>
                ) : (
                  <span className="draft-tray-shot">
                    <Camera size={12} />
                    {t("chat.drafts.screenshot")}
                  </span>
                )}
                <span className="draft-tray-time">
                  {draftLabel(draft, locale)}
                </span>
              </div>

              <button
                type="button"
                className="draft-tray-insert"
                disabled={!isInsertable(draft)}
                onMouseDown={keepFocus}
                onClick={() => onInsert(draft.id)}
              >
                {draft.inserting ? (
                  <Loader className="draft-tray-spinner" size={13} />
                ) : (
                  t("chat.drafts.insert")
                )}
              </button>
              <button
                type="button"
                className="draft-tray-remove"
                title={t("chat.drafts.remove")}
                aria-label={t("chat.drafts.remove")}
                onMouseDown={keepFocus}
                onClick={() => onRemove(draft.id)}
              >
                <Trash size={14} />
              </button>
            </div>
          ))}
        </div>

        {error && (
          <div className="draft-tray-error" role="alert">
            {error}
          </div>
        )}

        <div className="draft-tray-hint">
          <CornerDownLeft size={12} />
          <span>{t("chat.drafts.hint", { hotkey: insertHotkey })}</span>
        </div>
      </div>

      {preview && (
        <ImagePreview
          src={preview.url}
          name={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
