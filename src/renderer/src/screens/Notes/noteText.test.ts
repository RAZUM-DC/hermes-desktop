import { describe, expect, it } from "vitest";
import { noteExcerpt, noteForChat, noteTitle } from "./noteText";

const auto = (n: number): string => `Заметка ${n}`;

describe("заголовок заметки", () => {
  it("берёт название, которое дал человек", () => {
    expect(noteTitle({ title: "Созвон", autoNumber: 3 }, auto)).toBe("Созвон");
  });

  it("подставляет номер, когда названия нет", () => {
    expect(noteTitle({ title: "", autoNumber: 3 }, auto)).toBe("Заметка 3");
  });

  it("считает название из одних пробелов отсутствующим", () => {
    expect(noteTitle({ title: "   ", autoNumber: 2 }, auto)).toBe("Заметка 2");
  });

  it("не показывает нулевой номер, если его почему-то не выдали", () => {
    expect(noteTitle({ title: "", autoNumber: 0 }, auto)).toBe("Заметка 1");
  });
});

describe("кусок текста для плитки", () => {
  it("короткий текст отдаёт целиком", () => {
    expect(noteExcerpt("две строки")).toBe("две строки");
  });

  it("схлопывает переносы и лишние пробелы", () => {
    expect(noteExcerpt("первый абзац\n\n  второй   абзац ")).toBe(
      "первый абзац второй абзац",
    );
  });

  it("обрывает длинный текст по границе слова", () => {
    const text = "слово ".repeat(60);
    const out = noteExcerpt(text, 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out).not.toMatch(/сло…$/);
  });

  it("не оставляет хвост в одно слово без пробелов неотрезанным", () => {
    const out = noteExcerpt("а".repeat(50), 10);
    expect(out).toBe(`${"а".repeat(10)}…`);
  });

  it("пустой текст отдаёт пустым", () => {
    expect(noteExcerpt("   \n  ")).toBe("");
  });
});

describe("заметка для поля ввода", () => {
  it("берёт заголовок и текст, когда заголовок написан человеком", () => {
    expect(noteForChat({ title: "Созвон", text: "обсудить сроки" })).toBe(
      "Созвон\nобсудить сроки",
    );
  });

  it("не тащит в сообщение автоматическое название", () => {
    // В заметке без заголовка title пустой, а «Заметка 3» собирается при
    // показе: для ассистента это пустой ярлык, и в сообщении ему не место.
    expect(noteForChat({ title: "", text: "обсудить сроки" })).toBe(
      "обсудить сроки",
    );
  });

  it("отдаёт один заголовок, если текста нет", () => {
    expect(noteForChat({ title: "Созвон", text: "   " })).toBe("Созвон");
  });

  it("на пустой заметке отдаёт пустую строку", () => {
    expect(noteForChat({ title: "  ", text: "\n" })).toBe("");
  });
});
