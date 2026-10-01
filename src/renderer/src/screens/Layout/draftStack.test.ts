import { describe, expect, it, vi } from "vitest";
import {
  clearDrafts,
  draftLabel,
  isInsertable,
  isRecognizing,
  markInserting,
  pushDraft,
  removeDraft,
  resolveTextDraft,
  STACK_LIMIT,
  type PendingDraft,
} from "./draftStack";

function shot(id: string): PendingDraft {
  return {
    id,
    kind: "image",
    at: 0,
    name: `${id}.png`,
    url: `blob:${id}`,
    file: new File([], `${id}.png`, { type: "image/png" }),
  };
}

function note(
  id: string,
  state: "recognizing" | "ready" | "empty" = "ready",
): PendingDraft {
  return {
    id,
    kind: "text",
    at: 0,
    text: state === "ready" ? `текст ${id}` : "",
    state,
  };
}

function attachment(id: string): PendingDraft {
  return {
    id,
    kind: "file",
    at: 0,
    name: `${id}.pdf`,
    file: new File([], `${id}.pdf`, { type: "application/pdf" }),
  };
}

describe("стек черновиков", () => {
  it("принимает вложение заметки, которое не картинка", () => {
    const stack = pushDraft([], attachment("doc"));
    expect(stack[0].kind).toBe("file");
    // Вставлять можно сразу: распознавать тут нечего.
    expect(isInsertable(stack[0])).toBe(true);
  });

  it("не пытается освободить ссылку у файла, которой у него нет", () => {
    const revoke = vi.fn();
    const stack = pushDraft([], attachment("doc"), STACK_LIMIT, revoke);
    removeDraft(stack, "doc", revoke);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("вмещает заметку с текстом и несколькими вложениями целиком", () => {
    // Ради этого и поднимали предел: заметка приезжает несколькими строками
    // сразу, и её собственный текст не должен вытеснить её же файлы.
    let stack: PendingDraft[] = [];
    for (let i = 0; i < 4; i++) stack = pushDraft(stack, attachment(`f${i}`));
    stack = pushDraft(stack, note("текст"));
    expect(stack).toHaveLength(5);
    expect(stack[0].id).toBe("текст");
  });

  it("кладёт новый черновик наверх, снимки и заметки в одном списке", () => {
    const stack = pushDraft(pushDraft([], shot("a")), note("b"));
    expect(stack.map((d) => d.id)).toEqual(["b", "a"]);
  });

  it("вытесняет самый старый и освобождает его ссылку", () => {
    const revoke = vi.fn();
    let stack: PendingDraft[] = [];
    for (let i = 0; i < STACK_LIMIT; i++) {
      stack = pushDraft(stack, shot(`s${i}`), STACK_LIMIT, revoke);
    }
    expect(revoke).not.toHaveBeenCalled();

    stack = pushDraft(stack, note("new"), STACK_LIMIT, revoke);
    expect(stack).toHaveLength(STACK_LIMIT);
    expect(stack[0].id).toBe("new");
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:s0");
  });

  it("вытеснение заметки ничего не освобождает", () => {
    const revoke = vi.fn();
    let stack: PendingDraft[] = [];
    for (let i = 0; i < STACK_LIMIT; i++) {
      stack = pushDraft(stack, note(`n${i}`), STACK_LIMIT, revoke);
    }
    stack = pushDraft(stack, note("new"), STACK_LIMIT, revoke);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("удаляет по id и освобождает ссылку только у снимка", () => {
    const revoke = vi.fn();
    const stack = pushDraft(pushDraft([], shot("a")), note("b"));
    expect(removeDraft(stack, "b", revoke).map((d) => d.id)).toEqual(["a"]);
    expect(revoke).not.toHaveBeenCalled();
    expect(removeDraft(stack, "a", revoke).map((d) => d.id)).toEqual(["b"]);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:a");
  });

  it("неизвестный id ничего не трогает", () => {
    const revoke = vi.fn();
    const stack = pushDraft([], shot("a"));
    expect(removeDraft(stack, "нет такого", revoke)).toBe(stack);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("очистка освобождает ссылки снимков", () => {
    const revoke = vi.fn();
    const stack = pushDraft(
      pushDraft(pushDraft([], shot("a")), note("b")),
      shot("c"),
    );
    expect(clearDrafts(stack, revoke)).toEqual([]);
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("пометка о вставке не трогает остальные черновики", () => {
    const stack = pushDraft(pushDraft([], shot("a")), note("b"));
    const busy = markInserting(stack, "a", true);
    expect(busy.find((d) => d.id === "a")?.inserting).toBe(true);
    expect(busy.find((d) => d.id === "b")?.inserting).toBeUndefined();
  });

  it("распознанный текст достраивает заметку", () => {
    const stack = pushDraft([], note("n", "recognizing"));
    const done = resolveTextDraft(stack, "n", "  привет  ");
    const draft = done[0];
    expect(draft.kind === "text" && draft.text).toBe("привет");
    expect(draft.kind === "text" && draft.state).toBe("ready");
  });

  it("пустое распознавание оставляет строку с пометкой", () => {
    const stack = pushDraft([], note("n", "recognizing"));
    const done = resolveTextDraft(stack, "n", "   ");
    const draft = done[0];
    expect(draft.kind === "text" && draft.state).toBe("empty");
    expect(isInsertable(draft)).toBe(false);
  });

  it("вставлять можно снимок и готовую заметку, но не распознаваемую", () => {
    expect(isInsertable(shot("a"))).toBe(true);
    expect(isInsertable(note("b"))).toBe(true);
    expect(isInsertable(note("c", "recognizing"))).toBe(false);
    expect(isInsertable({ ...shot("d"), inserting: true })).toBe(false);
  });

  it("ждём распознавание, пока в стеке есть незавершённая заметка", () => {
    expect(isRecognizing([])).toBe(false);
    expect(isRecognizing([shot("a")])).toBe(false);
    expect(isRecognizing([note("b")])).toBe(false);
    expect(isRecognizing([note("c", "empty")])).toBe(false);
    expect(isRecognizing([shot("a"), note("c", "recognizing")])).toBe(true);
  });

  it("снятая или отменённая заметка снимает ожидание", () => {
    const stack = pushDraft([], note("n", "recognizing"));
    expect(isRecognizing(stack)).toBe(true);
    // Текст приехал.
    expect(isRecognizing(resolveTextDraft(stack, "n", "привет"))).toBe(false);
    // Распознавание вернуло пустоту.
    expect(isRecognizing(resolveTextDraft(stack, "n", "  "))).toBe(false);
    // Диктовку отменили — строки больше нет.
    expect(isRecognizing(removeDraft(stack, "n"))).toBe(false);
  });

  it("подпись — время появления", () => {
    const at = new Date(2026, 0, 2, 9, 5).getTime();
    expect(draftLabel({ ...note("a"), at }, "ru")).toMatch(/09.05/);
  });
});
