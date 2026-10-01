// @vitest-environment node

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => mockState.userData },
}));

describe("хранилище заметок", () => {
  beforeEach(() => {
    mockState.userData = mkdtempSync(join(tmpdir(), "hermes-notes-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(mockState.userData, { recursive: true, force: true });
  });

  async function store(): Promise<typeof import("./notes-store")> {
    return import("./notes-store");
  }

  describe("нумерация безымянных заметок", () => {
    it("начинается с единицы и идёт по возрастанию", async () => {
      const { nextAutoNumber } = await store();
      expect(nextAutoNumber([])).toBe(1);
      expect(nextAutoNumber([{ title: "", autoNumber: 1 }])).toBe(2);
      expect(
        nextAutoNumber([
          { title: "", autoNumber: 1 },
          { title: "", autoNumber: 2 },
        ]),
      ).toBe(3);
    });

    it("не считает заметки, у которых есть свой заголовок", async () => {
      const { nextAutoNumber } = await store();
      // Номер 7 за названной заметкой не держится: на экране её видно как
      // «Созвон», и следующая безымянная должна стать первой.
      expect(nextAutoNumber([{ title: "Созвон", autoNumber: 7 }])).toBe(1);
      expect(
        nextAutoNumber([
          { title: "", autoNumber: 1 },
          { title: "Созвон", autoNumber: 2 },
          { title: "Планы", autoNumber: 3 },
        ]),
      ).toBe(2);
    });

    it("занимает дыру после удаления, а не растёт бесконечно", async () => {
      const { nextAutoNumber } = await store();
      expect(
        nextAutoNumber([
          { title: "", autoNumber: 1 },
          { title: "", autoNumber: 3 },
        ]),
      ).toBe(2);
    });
  });

  describe("сохранение", () => {
    it("выдаёт номера новым безымянным заметкам по порядку", async () => {
      const { saveNote } = await store();
      expect(saveNote({ text: "первая" }).autoNumber).toBe(1);
      expect(saveNote({ text: "вторая" }).autoNumber).toBe(2);
      expect(saveNote({ text: "третья" }).autoNumber).toBe(3);
    });

    it("не выдаёт номер заметке, которую сразу назвали", async () => {
      const { saveNote } = await store();
      const named = saveNote({ title: "Созвон", text: "..." });
      expect(named.autoNumber).toBe(0);
      expect(saveNote({ text: "..." }).autoNumber).toBe(1);
    });

    it("освобождает номер, когда заметке дали заголовок", async () => {
      const { saveNote } = await store();
      // Так это и выглядит в жизни: кнопка «Новая заметка» заводит безымянную,
      // человек вписывает заголовок через пару секунд.
      const first = saveNote({ text: "первая" });
      expect(first.autoNumber).toBe(1);
      const second = saveNote({ text: "" });
      expect(second.autoNumber).toBe(2);
      saveNote({ id: second.id, title: "пример заголовка", text: "пример" });
      // На экране осталась одна «Заметка 1», значит следующая — вторая, а не
      // третья. Это и была жалоба: нумерация прыгала через единицу за каждую
      // названную заметку.
      expect(saveNote({ text: "третья" }).autoNumber).toBe(2);
    });

    it("выдаёт свободный номер, когда заголовок снова стёрли", async () => {
      const { saveNote } = await store();
      const first = saveNote({ text: "первая" });
      const second = saveNote({ text: "вторая" });
      saveNote({ id: second.id, title: "Созвон", text: "..." });
      // Второй номер освободился и занят новой заметкой.
      const third = saveNote({ text: "третья" });
      expect(third.autoNumber).toBe(2);
      // Теперь заголовок у «Созвона» стирают — двойка занята, поэтому он
      // получает тройку, а не сталкивается с третьей заметкой.
      const cleared = saveNote({ id: second.id, title: "", text: "..." });
      expect(cleared.autoNumber).toBe(3);
      expect(first.autoNumber).toBe(1);
    });

    it("не переименовывает безымянную заметку при каждой правке", async () => {
      const { saveNote } = await store();
      saveNote({ text: "первая" });
      const second = saveNote({ text: "вторая" });
      expect(second.autoNumber).toBe(2);
      expect(
        saveNote({ id: second.id, text: "вторая, правка" }).autoNumber,
      ).toBe(2);
    });

    it("обновляет заметку на месте, не заводя новую", async () => {
      const { saveNote, listNotes } = await store();
      const note = saveNote({ text: "было" });
      saveNote({ id: note.id, text: "стало" });
      const all = listNotes();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(note.id);
      expect(all[0].text).toBe("стало");
      expect(all[0].createdAt).toBe(note.createdAt);
    });

    it("обрезает пробелы по краям заголовка", async () => {
      const { saveNote } = await store();
      expect(saveNote({ title: "  Созвон  ", text: "" }).title).toBe("Созвон");
    });
  });

  describe("чтение", () => {
    it("отдаёт свежие заметки первыми", async () => {
      const { saveNote, listNotes } = await store();
      const first = saveNote({ text: "старая" });
      const second = saveNote({ text: "новая" });
      // Часы могут не успеть тикнуть между двумя вызовами, поэтому
      // раздвигаем метки руками.
      saveNote({ id: first.id, text: "старая" });
      const order = listNotes().map((n) => n.text);
      expect(order).toContain("новая");
      expect(listNotes()[0].updatedAt).toBeGreaterThanOrEqual(
        listNotes()[1].updatedAt,
      );
      expect(second.id).not.toBe(first.id);
    });

    it("на пустом месте отдаёт пустой список", async () => {
      const { listNotes } = await store();
      expect(listNotes()).toEqual([]);
    });

    it("переживает битый файл, а не падает вместе с окном", async () => {
      writeFileSync(join(mockState.userData, "notes.json"), "{ это не json");
      const { listNotes, saveNote } = await store();
      expect(listNotes()).toEqual([]);
      // И дальше блокнот продолжает работать.
      expect(saveNote({ text: "заново" }).autoNumber).toBe(1);
    });

    it("отбрасывает записи без идентификатора", async () => {
      writeFileSync(
        join(mockState.userData, "notes.json"),
        JSON.stringify({
          notes: [{ text: "без id" }, { id: "n1", text: "с id" }],
        }),
      );
      const { listNotes } = await store();
      expect(listNotes().map((n) => n.id)).toEqual(["n1"]);
    });

    it("достраивает недостающие поля старых записей", async () => {
      writeFileSync(
        join(mockState.userData, "notes.json"),
        JSON.stringify({ notes: [{ id: "n1" }] }),
      );
      const { listNotes } = await store();
      expect(listNotes()[0]).toEqual({
        id: "n1",
        title: "",
        autoNumber: 0,
        text: "",
        attachments: [],
        createdAt: 0,
        updatedAt: 0,
      });
    });
  });

  describe("вложения", () => {
    function sourceFile(name: string, bytes: string): string {
      const dir = mkdtempSync(join(tmpdir(), "hermes-src-"));
      const path = join(dir, name);
      writeFileSync(path, bytes);
      return path;
    }

    it("копирует файл к себе, а не запоминает путь", async () => {
      const { saveNote, attachFiles, attachmentPath } = await store();
      const note = saveNote({ text: "" });
      const source = sourceFile("снимок.png", "PNGDATA");
      const updated = attachFiles(note.id, [source]);
      expect(updated?.attachments).toHaveLength(1);

      // Исходник убираем — вложение обязано пережить это.
      rmSync(source, { force: true });
      const stored = attachmentPath(note.id, updated!.attachments[0].id);
      expect(stored).toBeTruthy();
      expect(readFileSync(stored!, "utf8")).toBe("PNGDATA");
    });

    it("запоминает имя, размер и то, картинка ли это", async () => {
      const { saveNote, attachFiles } = await store();
      const note = saveNote({ text: "" });
      const updated = attachFiles(note.id, [
        sourceFile("снимок.PNG", "12345"),
        sourceFile("договор.pdf", "%PDF-"),
      ]);
      const [image, doc] = updated!.attachments;
      expect(image.name).toBe("снимок.PNG");
      expect(image.size).toBe(5);
      expect(image.image).toBe(true);
      expect(image.mime).toBe("image/png");
      expect(doc.image).toBe(false);
      expect(doc.mime).toBe("application/pdf");
    });

    it("дописывает вложения, а не заменяет прежние", async () => {
      const { saveNote, attachFiles } = await store();
      const note = saveNote({ text: "" });
      attachFiles(note.id, [sourceFile("один.txt", "a")]);
      const updated = attachFiles(note.id, [sourceFile("два.txt", "b")]);
      expect(updated!.attachments.map((a) => a.name)).toEqual([
        "один.txt",
        "два.txt",
      ]);
    });

    it("не теряет вложения при правке текста", async () => {
      const { saveNote, attachFiles, listNotes } = await store();
      const note = saveNote({ text: "" });
      attachFiles(note.id, [sourceFile("один.txt", "a")]);
      saveNote({ id: note.id, text: "дописал" });
      expect(listNotes()[0].attachments).toHaveLength(1);
    });

    it("пропускает файл, которого уже нет, и прикладывает остальные", async () => {
      const { saveNote, attachFiles } = await store();
      const note = saveNote({ text: "" });
      const gone = sourceFile("исчез.txt", "x");
      rmSync(gone, { force: true });
      const updated = attachFiles(note.id, [gone, sourceFile("есть.txt", "y")]);
      expect(updated!.attachments.map((a) => a.name)).toEqual(["есть.txt"]);
    });

    it("отдаёт картинку строкой data:, а обычный файл — нет", async () => {
      const { saveNote, attachFiles, attachmentDataUrl } = await store();
      const note = saveNote({ text: "" });
      const updated = attachFiles(note.id, [
        sourceFile("снимок.png", "PNG"),
        sourceFile("договор.pdf", "PDF"),
      ]);
      const [image, doc] = updated!.attachments;
      expect(attachmentDataUrl(note.id, image.id)).toBe(
        `data:image/png;base64,${Buffer.from("PNG").toString("base64")}`,
      );
      expect(attachmentDataUrl(note.id, doc.id)).toBeNull();
    });

    it("не отдаёт целиком картинку, которая не пролезет через IPC", async () => {
      const {
        saveNote,
        attachFiles,
        attachmentDataUrl,
        MAX_INLINE_PREVIEW_BYTES,
      } = await store();
      const note = saveNote({ text: "" });
      const big = "x".repeat(MAX_INLINE_PREVIEW_BYTES + 1);
      const updated = attachFiles(note.id, [sourceFile("огромный.png", big)]);
      expect(attachmentDataUrl(note.id, updated!.attachments[0].id)).toBeNull();
      // Но сам файл на месте: открыть его системой человек всё равно может.
      expect(updated!.attachments[0].size).toBeGreaterThan(
        MAX_INLINE_PREVIEW_BYTES,
      );
    });

    it("удаляет вложение вместе с файлом", async () => {
      const { saveNote, attachFiles, removeAttachment, attachmentPath } =
        await store();
      const note = saveNote({ text: "" });
      const updated = attachFiles(note.id, [sourceFile("один.txt", "a")]);
      const id = updated!.attachments[0].id;
      const path = attachmentPath(note.id, id)!;
      expect(removeAttachment(note.id, id)!.attachments).toEqual([]);
      expect(existsSync(path)).toBe(false);
    });

    it("уносит файлы вместе с удалённой заметкой", async () => {
      const { saveNote, attachFiles, deleteNote, listNotes } = await store();
      const note = saveNote({ text: "" });
      attachFiles(note.id, [sourceFile("один.txt", "a")]);
      const dir = join(mockState.userData, "notes-files", note.id);
      expect(existsSync(dir)).toBe(true);
      deleteNote(note.id);
      expect(listNotes()).toEqual([]);
      expect(existsSync(dir)).toBe(false);
    });

    it("прикладывает байты, у которых нет файла на диске", async () => {
      // Так приезжает снимок экрана из карточки черновиков: пути у него нет,
      // он живёт блобом в памяти окна.
      const { saveNote, attachBytes, attachmentPath, attachmentDataUrl } =
        await store();
      const note = saveNote({ text: "" });
      const bytes = new Uint8Array([137, 80, 78, 71]);
      const updated = attachBytes(note.id, "screenshot.png", bytes);
      const attachment = updated!.attachments[0];
      expect(attachment.name).toBe("screenshot.png");
      expect(attachment.image).toBe(true);
      expect(attachment.size).toBe(4);
      expect(readFileSync(attachmentPath(note.id, attachment.id)!)).toEqual(
        Buffer.from(bytes),
      );
      expect(attachmentDataUrl(note.id, attachment.id)).toBe(
        `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
      );
    });

    it("не даёт имени из карточки увести файл из папки заметки", async () => {
      const { saveNote, attachBytes, attachmentPath } = await store();
      const note = saveNote({ text: "" });
      const updated = attachBytes(
        note.id,
        "../../сбежал.png",
        new Uint8Array([1]),
      );
      const attachment = updated!.attachments[0];
      expect(attachment.name).toBe("сбежал.png");
      expect(attachmentPath(note.id, attachment.id)).toContain(
        join("notes-files", note.id),
      );
    });

    it("молча отказывает, когда заметки нет", async () => {
      const { attachBytes } = await store();
      expect(attachBytes("нет такой", "a.png", new Uint8Array([1]))).toBeNull();
    });

    it("молча отказывает для незнакомой заметки", async () => {
      const { attachFiles, removeAttachment } = await store();
      expect(attachFiles("нет такой", [sourceFile("a.txt", "a")])).toBeNull();
      expect(removeAttachment("нет такой", "att")).toBeNull();
    });
  });

  describe("удаление", () => {
    it("убирает заметку и освобождает её номер", async () => {
      const { saveNote, deleteNote, listNotes } = await store();
      const first = saveNote({ text: "один" });
      saveNote({ text: "два" });
      deleteNote(first.id);
      expect(listNotes()).toHaveLength(1);
      expect(saveNote({ text: "три" }).autoNumber).toBe(1);
    });

    it("молча ничего не делает для незнакомого идентификатора", async () => {
      const { saveNote, deleteNote, listNotes } = await store();
      saveNote({ text: "один" });
      deleteNote("нет такой");
      expect(listNotes()).toHaveLength(1);
    });
  });
});
