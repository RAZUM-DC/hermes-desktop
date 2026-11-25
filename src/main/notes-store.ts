import { app } from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, extname, join } from "path";
import type { Note, NoteAttachment } from "../shared/notes";

/**
 * Хранилище заметок.
 *
 * Файл рядом с остальными данными приложения, а не таблица в базе. Причина
 * не в простоте: в гибридном режиме базы просто нет — `getDbConnection()`
 * возвращает null, потому что SQLite живёт на стороне локальной установки
 * Hermes, которой у нас не поднимается. Заметки должны работать в том
 * единственном режиме, в котором работает приложение, поэтому они идут тем же
 * путём, что и горячие клавиши: маленький JSON в userData.
 *
 * Запись атомарная, через временный файл: заметки человек правит по ходу
 * разговора, и оборванная на середине запись стоила бы ему всего блокнота, а
 * не одной последней правки.
 *
 * Приложенные файлы в JSON не лежат — только их описание. Сами файлы
 * копируются в подпапку рядом, по папке на заметку. Держать картинку в том же
 * файле, что и текст, значило бы переписывать десяток мегабайт при каждой
 * правке буквы и читать их обратно при каждом открытии блокнота.
 */

interface NotesFile {
  notes: Note[];
}

function notesPath(): string {
  return join(app.getPath("userData"), "notes.json");
}

function filesRoot(): string {
  return join(app.getPath("userData"), "notes-files");
}

function noteDir(noteId: string): string {
  return join(filesRoot(), noteId);
}

/**
 * Наименьший свободный номер среди заметок, которые СЕЙЧАС показаны с
 * автоматическим названием.
 *
 * Названные заметки номер не занимают, и это главное здесь. Человек видит на
 * экране «Заметка 1» и три заметки со своими заголовками — следующая новая
 * должна стать «Заметкой 2», потому что именно так читается то, что у него
 * перед глазами. Если бы названные держали за собой номера, выданные в те
 * несколько секунд, пока заголовок ещё не вписали, нумерация прыгала бы через
 * единицы без всякой видимой причины.
 *
 * Отсюда же следует, что заметка, которую назвали, свой номер отдаёт
 * насовсем (`autoNumber` обнуляется), а если название потом стереть, она
 * получит новый. Иначе два разных номера могли бы совпасть и на экране
 * оказались бы две «Заметки 2».
 */
export function nextAutoNumber(
  notes: Pick<Note, "title" | "autoNumber">[],
): number {
  const taken = new Set(
    notes
      .filter((n) => !n.title.trim() && n.autoNumber > 0)
      .map((n) => n.autoNumber),
  );
  let candidate = 1;
  while (taken.has(candidate)) candidate += 1;
  return candidate;
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".avif",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

export function mimeForFile(name: string): string {
  return (
    MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream"
  );
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(name).toLowerCase());
}

function normalizeAttachment(value: unknown): NoteAttachment | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return null;
  const name = typeof raw.name === "string" ? raw.name : id;
  return {
    id,
    name,
    mime: typeof raw.mime === "string" ? raw.mime : mimeForFile(name),
    size: typeof raw.size === "number" ? raw.size : 0,
    image: typeof raw.image === "boolean" ? raw.image : isImageFile(name),
    addedAt: typeof raw.addedAt === "number" ? raw.addedAt : 0,
  };
}

/** Приводит запись из файла к Note, отбрасывая мусор. */
function normalizeNote(value: unknown): Note | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return null;
  const num =
    typeof raw.autoNumber === "number" ? Math.trunc(raw.autoNumber) : 0;
  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "",
    autoNumber: num > 0 ? num : 0,
    text: typeof raw.text === "string" ? raw.text : "",
    attachments: Array.isArray(raw.attachments)
      ? raw.attachments
          .map(normalizeAttachment)
          .filter((a): a is NoteAttachment => a !== null)
      : [],
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

function readFile(): Note[] {
  const file = notesPath();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<NotesFile>;
    if (!Array.isArray(parsed?.notes)) return [];
    return parsed.notes.map(normalizeNote).filter((n): n is Note => n !== null);
  } catch {
    // Битый файл не повод терять управление: показываем пустой блокнот, а
    // следующая сохранённая заметка перезапишет его целиком.
    return [];
  }
}

function writeAll(notes: Note[]): void {
  const file = notesPath();
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ notes }, null, 2)}\n`);
  renameSync(temp, file);
}

/** Заметки от свежих к старым — в том порядке, в каком их показывает экран. */
export function listNotes(): Note[] {
  return readFile().sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface NoteInput {
  /** Пусто или отсутствует — завести новую заметку. */
  id?: string;
  title?: string;
  text?: string;
}

/**
 * Создаёт заметку или обновляет существующую и возвращает её в том виде, в
 * котором она легла на диск.
 */
export function saveNote(input: NoteInput): Note {
  const notes = readFile();
  const now = Date.now();
  const title = (input.title ?? "").trim();
  const text = input.text ?? "";

  const at = input.id ? notes.findIndex((n) => n.id === input.id) : -1;
  if (at >= 0) {
    const previous = notes[at];
    const others = notes.filter((_, i) => i !== at);
    const keepsNumber =
      previous.autoNumber > 0 &&
      !others.some(
        (n) => !n.title.trim() && n.autoNumber === previous.autoNumber,
      );
    const updated: Note = {
      ...previous,
      title,
      text,
      autoNumber: title
        ? 0
        : keepsNumber
          ? previous.autoNumber
          : nextAutoNumber(others),
      updatedAt: now,
    };
    notes[at] = updated;
    writeAll(notes);
    return updated;
  }

  const created: Note = {
    id: `note-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    autoNumber: title ? 0 : nextAutoNumber(notes),
    text,
    attachments: [],
    createdAt: now,
    updatedAt: now,
  };
  notes.push(created);
  writeAll(notes);
  return created;
}

export function deleteNote(id: string): void {
  const notes = readFile();
  const left = notes.filter((n) => n.id !== id);
  if (left.length === notes.length) return;
  writeAll(left);
  // Файлы удаляем вслед за заметкой: иначе картинки остались бы лежать в
  // userData навсегда, и человек не имел бы никакого способа до них добраться.
  rmSync(noteDir(id), { recursive: true, force: true });
}

/**
 * Копирует файлы в хранилище заметки и дописывает их в её список.
 *
 * Именно копирует, а не запоминает путь. Человек прикладывает файл к заметке,
 * чтобы он там был; если запомнить путь, то переложенный в другую папку или
 * удалённый файл превратил бы вложение в мёртвую ссылку, о которой ничего
 * нельзя сказать, кроме имени.
 */
export function attachFiles(noteId: string, sources: string[]): Note | null {
  const notes = readFile();
  const at = notes.findIndex((n) => n.id === noteId);
  if (at < 0) return null;

  const dir = noteDir(noteId);
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const added: NoteAttachment[] = [];

  for (const source of sources) {
    let size = 0;
    try {
      size = statSync(source).size;
    } catch {
      // Файл исчез между выбором в диалоге и копированием — пропускаем его
      // молча, остальные прикладываем.
      continue;
    }
    const name = source.split(/[\\/]/).pop() || "file";
    const id = `att-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // Расширение сохраняем в имени файла на диске: по нему система поймёт,
    // чем открывать вложение, когда человек на него нажмёт.
    const stored = join(dir, `${id}${extname(name).toLowerCase()}`);
    try {
      copyFileSync(source, stored);
    } catch {
      continue;
    }
    added.push({
      id,
      name,
      mime: mimeForFile(name),
      size,
      image: isImageFile(name),
      addedAt: now,
    });
  }

  if (added.length === 0) return notes[at];
  const updated: Note = {
    ...notes[at],
    attachments: [...notes[at].attachments, ...added],
    updatedAt: now,
  };
  notes[at] = updated;
  writeAll(notes);
  return updated;
}

/**
 * Прикладывает к заметке файл, которого на диске ещё нет.
 *
 * Так приезжают снимки экрана из карточки черновиков: там они живут не
 * файлом, а блобом в памяти окна, и приложить их по пути нельзя — пути у них
 * просто нет. Байты едут через IPC одним куском, и этого достаточно: снимок
 * экрана — это мегабайт-другой.
 */
export function attachBytes(
  noteId: string,
  name: string,
  bytes: Uint8Array,
): Note | null {
  const notes = readFile();
  const at = notes.findIndex((n) => n.id === noteId);
  if (at < 0) return null;

  const dir = noteDir(noteId);
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const id = `att-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const safeName = name.split(/[\\/]/).pop() || "file";
  try {
    writeFileSync(join(dir, `${id}${extname(safeName).toLowerCase()}`), bytes);
  } catch {
    return notes[at];
  }

  const updated: Note = {
    ...notes[at],
    attachments: [
      ...notes[at].attachments,
      {
        id,
        name: safeName,
        mime: mimeForFile(safeName),
        size: bytes.byteLength,
        image: isImageFile(safeName),
        addedAt: now,
      },
    ],
    updatedAt: now,
  };
  notes[at] = updated;
  writeAll(notes);
  return updated;
}

/** Путь до приложенного файла на диске, или null, если такого нет. */
export function attachmentPath(
  noteId: string,
  attachmentId: string,
): string | null {
  const note = readFile().find((n) => n.id === noteId);
  const attachment = note?.attachments.find((a) => a.id === attachmentId);
  if (!attachment) return null;
  const path = join(
    noteDir(noteId),
    `${attachmentId}${extname(attachment.name).toLowerCase()}`,
  );
  return existsSync(path) ? path : null;
}

/**
 * Содержимое вложения байтами — для случая, когда файл нужен целиком.
 *
 * Так заметка уезжает в диалог: поле ввода чата принимает File, а собрать его
 * в окне можно только из байтов. Ограничения на размер здесь нет намеренно —
 * их накладывает сам чат при разборе вложений, и дублировать его правила
 * значило бы однажды разойтись с ними.
 */
export function attachmentBytes(
  noteId: string,
  attachmentId: string,
): Uint8Array | null {
  const path = attachmentPath(noteId, attachmentId);
  if (!path) return null;
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    return null;
  }
}

/**
 * Содержимое картинки строкой data: — тем, чем её покажет тег <img>.
 *
 * Крупные файлы не отдаём. Картинка едет в рендерер через IPC одним куском, и
 * двадцатимегабайтный снимок, раздутый base64 до двадцати семи, подвесил бы
 * окно на заметное время. Такое вложение показывается обычной плашкой с
 * именем — открыть его всё равно можно, уже системным просмотрщиком.
 */
export const MAX_INLINE_PREVIEW_BYTES = 12 * 1024 * 1024;

export function attachmentDataUrl(
  noteId: string,
  attachmentId: string,
): string | null {
  const note = readFile().find((n) => n.id === noteId);
  const attachment = note?.attachments.find((a) => a.id === attachmentId);
  if (!attachment || !attachment.image) return null;
  if (attachment.size > MAX_INLINE_PREVIEW_BYTES) return null;
  const path = attachmentPath(noteId, attachmentId);
  if (!path) return null;
  try {
    return `data:${attachment.mime};base64,${readFileSync(path).toString("base64")}`;
  } catch {
    return null;
  }
}

export function removeAttachment(
  noteId: string,
  attachmentId: string,
): Note | null {
  const notes = readFile();
  const at = notes.findIndex((n) => n.id === noteId);
  if (at < 0) return null;
  const attachment = notes[at].attachments.find((a) => a.id === attachmentId);
  if (!attachment) return notes[at];
  const path = join(
    noteDir(noteId),
    `${attachmentId}${extname(attachment.name).toLowerCase()}`,
  );
  rmSync(path, { force: true });
  const updated: Note = {
    ...notes[at],
    attachments: notes[at].attachments.filter((a) => a.id !== attachmentId),
    updatedAt: Date.now(),
  };
  notes[at] = updated;
  writeAll(notes);
  return updated;
}
