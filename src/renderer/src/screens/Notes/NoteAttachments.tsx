import { useEffect, useState } from "react";
import { Paperclip, X } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";
import type { NoteAttachment } from "../../../../shared/notes";

/**
 * Вложения открытой заметки.
 *
 * Картинки показываются прямо здесь, остальное — плашкой с именем и размером.
 * Открывает вложение система, своего просмотрщика нет намеренно: писать его
 * ради pdf и docx значило бы сделать хуже того, что у человека уже стоит.
 */

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Картинка вложения.
 *
 * Содержимое запрашивается отдельно и только когда плитка появилась на
 * экране: файлы едут через IPC одним куском, и тянуть их все сразу при
 * открытии заметки значило бы подвешивать окно на каждой заметке с десятком
 * снимков. Для крупных картинок main отдаёт null — тогда остаётся та же
 * плашка с именем, что и у обычного файла.
 */
function AttachmentImage({
  noteId,
  attachment,
}: {
  noteId: string;
  attachment: NoteAttachment;
}): React.JSX.Element | null {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.hermesAPI
      .notesAttachmentData(noteId, attachment.id)
      .then((data) => {
        if (!alive) return;
        if (data) setSrc(data);
        else setFailed(true);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [noteId, attachment.id]);

  if (failed) return null;
  if (!src) return <div className="notes-attachment-loading" />;
  return (
    <img className="notes-attachment-image" src={src} alt={attachment.name} />
  );
}

interface NoteAttachmentsProps {
  noteId: string;
  attachments: NoteAttachment[];
  onRemove: (attachmentId: string) => void;
}

export function NoteAttachments({
  noteId,
  attachments,
  onRemove,
}: NoteAttachmentsProps): React.JSX.Element | null {
  const { t } = useI18n();
  if (attachments.length === 0) return null;

  return (
    <div className="notes-attachments">
      {attachments.map((a) => (
        <div key={a.id} className="notes-attachment">
          <button
            className="notes-attachment-body"
            onClick={() =>
              void window.hermesAPI.notesAttachmentOpen(noteId, a.id)
            }
            title={t("notes.openAttachment")}
          >
            {a.image ? (
              <AttachmentImage noteId={noteId} attachment={a} />
            ) : (
              <Paperclip size={16} className="notes-attachment-icon" />
            )}
            <span className="notes-attachment-name">{a.name}</span>
            <span className="notes-attachment-size">{humanSize(a.size)}</span>
          </button>
          <button
            className="notes-attachment-remove"
            onClick={() => onRemove(a.id)}
            title={t("notes.removeAttachment")}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export default NoteAttachments;
