import { describe, expect, it } from "vitest";
import { normalizeConnectionMode } from "./config";

describe("normalizeConnectionMode", () => {
  it("известные режимы отдаёт как есть", () => {
    expect(normalizeConnectionMode("local")).toBe("local");
    expect(normalizeConnectionMode("ssh")).toBe("ssh");
    expect(normalizeConnectionMode("remote")).toBe("remote");
  });

  it("без значения — гибрид", () => {
    // Сборка гибридная по устройству: companion стартует всегда и сам
    // записывает remote. Умолчание лишь совпадает с этим, а не спорит с ним.
    expect(normalizeConnectionMode(undefined)).toBe("remote");
    expect(normalizeConnectionMode(null)).toBe("remote");
    expect(normalizeConnectionMode("")).toBe("remote");
  });

  it("мусор в конфиге не роняет запуск", () => {
    // Файл правят руками, и опечатка не должна означать неизвестный режим.
    expect(normalizeConnectionMode("Remote")).toBe("remote");
    expect(normalizeConnectionMode("lokal")).toBe("remote");
    expect(normalizeConnectionMode(42)).toBe("remote");
    expect(normalizeConnectionMode({ mode: "ssh" })).toBe("remote");
  });
});
