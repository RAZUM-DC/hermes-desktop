import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentError } from "../Chat/attachmentUtils";
import { ArrowRight, Paperclip, Plus, Send, Trash } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";
import type { Note } from "../../../../shared/notes";
import { noteExcerpt, noteForChat, noteTitle } from "./noteText";
import { NoteAttachments } from "./NoteAttachments";

/**
 * Блокнот.
 *
 * Заметки лежат файлом на машине пользователя и никуда не уходят — ни в банк
 * памяти, ни на сервер. Это разные вещи, и их нарочно не свели в одну: банк
 * ассистент наполняет сам, по ходу разговоров, и оттуда ничего нельзя ни
 * дописать, ни стереть; сюда человек пишет руками то, что хочет держать под
 * рукой, и распоряжается этим сам.
 *
 * Экран из двух состояний: плитки и открытая заметка. Модального окна нет
 * намеренно — заметку чаще читают и правят подолгу, а модалка над чатом
 * заставляла бы закрывать её ради каждого взгляда на переписку.
 */

/**
 * Пауза перед сохранением правки.
 *
 * Кнопки «Сохранить» нет: заметка — не форма, и терять текст из-за того, что
 * человек ушёл на другую вкладку не нажав кнопку, недопустимо. Полсекунды —
 * достаточно, чтобы не писать файл на каждую букву, и достаточно мало, чтобы
 * ничего не пропало при переключении.
 */
const AUTOSAVE_DELAY_MS = 500;

function noteDate(at: number, locale: string): string {
  if (!at) return "";
  return new Date(at).toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

interface NotesProps {
  /**
   * Открыта ли вкладка прямо сейчас.
   *
   * Вкладки смонтированы все разом и прячутся через display: none, поэтому
   * карточку черновиков слушают обе — и чат, и блокнот. Без этой проверки
   * надиктованный текст лёг бы и в поле ввода чата, и в заметку.
   */
  active: boolean;
  /**
   * Положить заметку в карточку черновиков — туда же, где ждут снимки экрана
   * и надиктованное. Куда её вставить, человек решает сам.
   */
  onSendToTray: (text: string, files: File[]) => void;
}

export function Notes({ active, onSendToTray }: NotesProps): React.JSX.Element {
  const { t, locale } = useI18n();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftText, setDraftText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Таймер отложенного сохранения и последнее, что мы уже записали: по ним
  // решаем, нужно ли вообще идти в main при закрытии заметки.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ id: string; title: string; text: string } | null>(
    null,
  );

  // Карточка черновиков рассылает событие синхронно, и обработчик обязан
  // видеть то, что на экране сейчас, а не то, что было при подписке.
  const openIdRef = useRef<string | null>(null);
  const draftTextRef = useRef("");
  const draftTitleRef = useRef("");
  openIdRef.current = openId;
  draftTextRef.current = draftText;
  draftTitleRef.current = draftTitle;

  const autoLabel = useCallback(
    (n: number): string => t("notes.autoTitle", { number: n }),
    [t],
  );

  const load = useCallback(async (): Promise<void> => {
    try {
      setNotes(await window.hermesAPI.notesList());
    } catch {
      // Блокнот локальный: читать нечему сломаться, кроме битого файла, а его
      // хранилище уже разобрало само. Показываем пустой список.
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flush = useCallback(async (): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    const saved = await window.hermesAPI.notesSave(next);
    setNotes((prev) => prev.map((n) => (n.id === saved.id ? saved : n)));
  }, []);

  // Страховка на случай, когда экран уходит вместе с окном: правка, которая
  // ждала своей половины секунды, иначе не доехала бы до диска.
  useEffect(() => {
    const onLeave = (): void => {
      void flush();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("beforeunload", onLeave);
      void flush();
    };
  }, [flush]);

  const queueSave = useCallback((id: string, title: string, text: string) => {
    pending.current = { id, title, text };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const next = pending.current;
      if (!next) return;
      pending.current = null;
      void window.hermesAPI.notesSave(next).then((saved) => {
        setNotes((prev) => prev.map((n) => (n.id === saved.id ? saved : n)));
      });
    }, AUTOSAVE_DELAY_MS);
  }, []);

  const open = useCallback((note: Note) => {
    setOpenId(note.id);
    setDraftTitle(note.title);
    setDraftText(note.text);
    setConfirmDelete(false);
  }, []);

  const close = useCallback(async (): Promise<void> => {
    await flush();
    setOpenId(null);
    setConfirmDelete(false);
    // Перечитываем: порядок плиток зависит от времени правки, а его проставил
    // main, а не мы.
    await load();
  }, [flush, load]);

  const create = useCallback(async (): Promise<void> => {
    await flush();
    const created = await window.hermesAPI.notesSave({ title: "", text: "" });
    setNotes((prev) => [created, ...prev]);
    open(created);
  }, [flush, open]);

  const remove = useCallback(async (): Promise<void> => {
    if (!openId) return;
    // Отменяем отложенную запись: иначе она воскресила бы только что удалённую
    // заметку через полсекунды после нажатия.
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    pending.current = null;
    await window.hermesAPI.notesDelete(openId);
    setNotes((prev) => prev.filter((n) => n.id !== openId));
    setOpenId(null);
    setConfirmDelete(false);
  }, [openId]);

  const attach = useCallback(async (): Promise<void> => {
    if (!openId) return;
    // Сбрасываем на диск то, что человек успел напечатать: пока открыт
    // системный диалог, отложенная запись не выполнится, а main возьмёт
    // заметку с диска и вернёт её вместе с вложением — вместе со старым
    // текстом, если его не записать сейчас.
    await flush();
    const updated = await window.hermesAPI.notesAttach(openId);
    if (updated) {
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
    }
  }, [flush, openId]);

  const detach = useCallback(
    async (attachmentId: string): Promise<void> => {
      if (!openId) return;
      await flush();
      const updated = await window.hermesAPI.notesAttachmentRemove(
        openId,
        attachmentId,
      );
      if (updated) {
        setNotes((prev) =>
          prev.map((n) => (n.id === updated.id ? updated : n)),
        );
      }
    },
    [flush, openId],
  );

  /**
   * Приём снимка или надиктованного текста из карточки черновиков.
   *
   * Если заметка открыта — кладём в неё. Если человек просто стоит на вкладке
   * «Заметки», заводим новую и открываем её: иначе вложение ушло бы неизвестно
   * куда, и единственным способом его найти было бы угадать, какая из плиток
   * изменилась.
   *
   * Текст дописывается к тому, что уже набрано, и не заменяет его — ровно как
   * в поле ввода чата: человек мог начать печатать до того, как распознавание
   * ответило.
   */
  const receiveDraft = useCallback(
    async (files: File[], text: string): Promise<AttachmentError[]> => {
      let targetId = openIdRef.current;
      let existingText = draftTextRef.current;
      // Заголовок берём из ref, а не из состояния: если заметку только что
      // завели, setState ещё не отработал, и draftTitle держал бы название
      // предыдущей открытой заметки — оно перезаписало бы её же.
      let existingTitle = draftTitleRef.current;

      if (!targetId) {
        const created = await window.hermesAPI.notesSave({
          title: "",
          text: "",
        });
        setNotes((prev) => [created, ...prev]);
        targetId = created.id;
        existingText = "";
        existingTitle = "";
        open(created);
      } else {
        // Сбрасываем на диск набранное: дальше заметку читает и перезаписывает
        // main, и несохранённые буквы иначе потерялись бы.
        await flush();
      }

      const errors: AttachmentError[] = [];

      if (text) {
        const merged = existingText ? `${existingText}\n${text}` : text;
        const saved = await window.hermesAPI.notesSave({
          id: targetId,
          title: existingTitle,
          text: merged,
        });
        setDraftText(merged);
        setNotes((prev) => prev.map((n) => (n.id === saved.id ? saved : n)));
      }

      for (const file of files) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const saved = await window.hermesAPI.notesAttachData(
            targetId,
            file.name,
            bytes,
          );
          if (saved) {
            setNotes((prev) =>
              prev.map((n) => (n.id === saved.id ? saved : n)),
            );
          }
        } catch {
          errors.push({ code: "read-failed", filename: file.name });
        }
      }

      return errors;
    },
    [flush, open],
  );

  useEffect(() => {
    if (!active) return;
    const onInsert = (event: Event): void => {
      const detail = (
        event as CustomEvent<{
          files?: File[];
          text?: string;
          accept?: (result: Promise<AttachmentError[]>) => void;
        }>
      ).detail;
      const files = detail?.files ?? [];
      const text = detail?.text?.trim() ?? "";
      if (files.length === 0 && !text) return;
      // Подтверждаем приём сразу, обещанием: карточка убирает черновик только
      // когда оно выполнится, иначе он исчез бы раньше, чем заметка заведена.
      detail?.accept?.(receiveDraft(files, text));
    };
    window.addEventListener("hermes-insert-draft", onInsert);
    return () => window.removeEventListener("hermes-insert-draft", onInsert);
  }, [active, receiveDraft]);

  /**
   * Отложить заметку в карточку черновиков: текст отдельной строкой, каждое
   * вложение — своей.
   *
   * Файлы собираются здесь заново из байтов: на диске они лежат под
   * служебными именами, а в карточке и в поле ввода человек должен видеть то
   * имя, под которым он их прикладывал.
   */
  const toTray = useCallback(async (): Promise<void> => {
    const note = notes.find((n) => n.id === openIdRef.current);
    if (!note || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await flush();
      const text = noteForChat({
        title: draftTitleRef.current,
        text: draftTextRef.current,
      });
      const files: File[] = [];
      for (const a of note.attachments) {
        const bytes = await window.hermesAPI.notesAttachmentBytes(
          note.id,
          a.id,
        );
        // Копия в обычный ArrayBuffer: Uint8Array из IPC типизирован как
        // ArrayBufferLike, а File принимает только не-разделяемый буфер.
        if (bytes) {
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          files.push(new File([copy], a.name, { type: a.mime }));
        }
      }
      if (!text && files.length === 0) {
        setSendError("empty");
        return;
      }
      onSendToTray(text, files);
      setSent(true);
    } finally {
      setSending(false);
    }
  }, [flush, notes, onSendToTray, sending]);

  // Подтверждение держится пару секунд: карточка появляется в другом углу
  // экрана, и без отметки у самой кнопки неясно, сработало ли нажатие.
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => setSent(false), 2500);
    return () => clearTimeout(timer);
  }, [sent]);

  const openNote = openId ? notes.find((n) => n.id === openId) : undefined;

  if (openNote) {
    return (
      <div className="settings-container notes-editor">
        <div className="notes-editor-bar">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => void close()}
          >
            <ArrowRight size={13} style={{ transform: "rotate(180deg)" }} />
            {t("notes.back")}
          </button>
          <button
            className="btn btn-secondary btn-sm notes-attach-btn"
            onClick={() => void attach()}
          >
            <Paperclip size={13} />
            {t("notes.attach")}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => void toTray()}
            disabled={sending}
          >
            <Send size={13} />
            {sent ? t("notes.toTraySent") : t("notes.toTray")}
          </button>
          {confirmDelete ? (
            <div className="notes-delete-confirm">
              <span className="settings-field-hint">
                {t("notes.deleteConfirm")}
              </span>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setConfirmDelete(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => void remove()}
              >
                {t("notes.delete")}
              </button>
            </div>
          ) : (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setConfirmDelete(true)}
              title={t("notes.delete")}
            >
              <Trash size={13} />
            </button>
          )}
        </div>

        {sendError && (
          <div className="settings-error" role="alert">
            {sendError === "empty"
              ? t("notes.toTrayEmpty")
              : t("chat.drafts.insertFailed")}
          </div>
        )}

        <input
          className="notes-title-input"
          value={draftTitle}
          placeholder={noteTitle(openNote, autoLabel)}
          onChange={(e) => {
            setDraftTitle(e.target.value);
            queueSave(openNote.id, e.target.value, draftText);
          }}
        />
        <textarea
          className="notes-text-input"
          value={draftText}
          placeholder={t("notes.textPlaceholder")}
          autoFocus
          onChange={(e) => {
            setDraftText(e.target.value);
            queueSave(openNote.id, draftTitle, e.target.value);
          }}
        />
        <NoteAttachments
          noteId={openNote.id}
          attachments={openNote.attachments}
          onRemove={(id) => void detach(id)}
        />
      </div>
    );
  }

  return (
    <div className="settings-container">
      <div className="memory-header">
        <div>
          <h1 className="settings-header" style={{ marginBottom: 4 }}>
            {t("notes.title")}
          </h1>
          <p className="memory-subtitle">{t("notes.subtitle")}</p>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => void create()}
        >
          <Plus size={13} />
          {t("notes.new")}
        </button>
      </div>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <div className="loading-spinner" />
        </div>
      ) : notes.length === 0 ? (
        <p className="memory-subtitle">{t("notes.empty")}</p>
      ) : (
        <div className="notes-grid">
          {notes.map((note) => {
            const excerpt = noteExcerpt(note.text);
            return (
              <button
                key={note.id}
                className="notes-tile"
                onClick={() => open(note)}
              >
                <span className="notes-tile-title">
                  {noteTitle(note, autoLabel)}
                </span>
                <span
                  className={`notes-tile-text ${excerpt ? "" : "notes-tile-text-empty"}`}
                >
                  {excerpt || t("notes.emptyBody")}
                </span>
                <span className="notes-tile-date">
                  {noteDate(note.updatedAt, locale)}
                  {note.attachments.length > 0 && (
                    <span className="notes-tile-clip">
                      <Paperclip size={11} />
                      {note.attachments.length}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default Notes;
