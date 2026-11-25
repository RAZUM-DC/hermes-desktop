import { describe, expect, it } from "vitest";
import {
  describeMemoryError,
  normalizeFact,
  normalizePage,
  parseFactTime,
} from "./memory-bank";

describe("parseFactTime", () => {
  it("разбирает ISO-строку", () => {
    expect(parseFactTime("2026-09-24T07:45:28.432759+00:00")).toBe(
      Date.parse("2026-09-24T07:45:28.432Z"),
    );
  });

  it("секунды отличает от миллисекунд", () => {
    // Hindsight отдаёт секунды; умножить забыть — и факт уедет в 1970-й.
    expect(parseFactTime(1790804967)).toBe(1790804967000);
    expect(parseFactTime(1790804967000)).toBe(1790804967000);
  });

  it("на отсутствующей и битой дате возвращает ноль", () => {
    expect(parseFactTime(undefined)).toBe(0);
    expect(parseFactTime(null)).toBe(0);
    expect(parseFactTime("")).toBe(0);
    expect(parseFactTime("позавчера")).toBe(0);
    expect(parseFactTime(Number.NaN)).toBe(0);
  });
});

describe("normalizeFact", () => {
  const row = {
    id: "m1",
    text: "  Ведёт дела по уголовным статьям  ",
    fact_type: "preference",
    tags: ["work", 42, null],
    state: "active",
    mentioned_at: "2026-09-24T07:45:28Z",
    metadata: { junk: true },
  };

  it("берёт нужные поля и чистит текст", () => {
    const f = normalizeFact(row)!;
    expect(f.text).toBe("Ведёт дела по уголовным статьям");
    expect(f.id).toBe("m1");
    expect(f.factType).toBe("preference");
    expect(f.state).toBe("active");
    expect(f.at).toBe(Date.parse("2026-09-24T07:45:28Z"));
  });

  it("из тегов оставляет только строки", () => {
    expect(normalizeFact(row)!.tags).toEqual(["work"]);
  });

  it("запись без текста отбрасывается", () => {
    // Факт без текста показывать нечем — пустая строка в списке хуже, чем её
    // отсутствие.
    expect(normalizeFact({ id: "x", text: "   " })).toBeNull();
    expect(normalizeFact({ id: "x" })).toBeNull();
    expect(normalizeFact(null)).toBeNull();
    expect(normalizeFact("строка")).toBeNull();
  });

  it("пропавшие необязательные поля не ломают разбор", () => {
    const f = normalizeFact({ text: "минимум" })!;
    expect(f.text).toBe("минимум");
    expect(f.id).toBe("");
    expect(f.tags).toEqual([]);
    expect(f.at).toBe(0);
  });
});

describe("normalizePage", () => {
  it("считает total и отбрасывает мусорные записи", () => {
    const page = normalizePage({
      items: [{ text: "раз" }, { text: "" }, null, { text: "два" }],
      total: 17,
    });
    expect(page.items.map((f) => f.text)).toEqual(["раз", "два"]);
    expect(page.total).toBe(17);
  });

  it("без total считает по фактам", () => {
    expect(normalizePage({ items: [{ text: "раз" }] }).total).toBe(1);
  });

  it("пустой и незнакомый ответ не роняют экран", () => {
    expect(normalizePage(null)).toEqual({ items: [], total: 0 });
    expect(normalizePage({})).toEqual({ items: [], total: 0 });
    expect(normalizePage({ items: "нет" })).toEqual({ items: [], total: 0 });
  });
});

describe("describeMemoryError", () => {
  it("403 — это запрет сервера, а не поломка", () => {
    // Человеку надо сказать «так нельзя», иначе он будет жать кнопку снова.
    expect(describeMemoryError(403, "blocked")).toBe("forbidden");
  });

  it("узнаёт недоступность транспорта", () => {
    for (const code of [502, 503, 504]) {
      expect(describeMemoryError(code, "")).toBe("unavailable");
    }
    expect(describeMemoryError(401, "")).toBe("unauthorized");
  });

  it("прочее отдаёт как есть, но не простыню", () => {
    expect(describeMemoryError(418, "я чайник")).toBe("я чайник");
    expect(describeMemoryError(500, "x".repeat(500)).length).toBe(200);
    expect(describeMemoryError(500, "")).toBe("HTTP 500");
  });
});
