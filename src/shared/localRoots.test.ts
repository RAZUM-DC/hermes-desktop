import { describe, expect, it } from "vitest";
import { isInsideRoots } from "./localRoots";

const ROOTS = [
  "C:\\Users\\ivan\\Documents",
  "C:\\Users\\ivan\\Downloads",
  "C:\\Users\\ivan\\Desktop",
];

describe("isInsideRoots", () => {
  it("сам корень считается доступным", () => {
    expect(isInsideRoots("C:\\Users\\ivan\\Documents", ROOTS)).toBe(true);
  });

  it("вложенная папка доступна на любой глубине", () => {
    expect(isInsideRoots("C:\\Users\\ivan\\Documents\\Проект", ROOTS)).toBe(
      true,
    );
    expect(isInsideRoots("C:\\Users\\ivan\\Desktop\\a\\b\\c", ROOTS)).toBe(
      true,
    );
  });

  it("соседняя папка с похожим именем — не внутри", () => {
    // Ради этого случая функция и существует: наивное «начинается с»
    // пропустило бы Documents2 как вложенную в Documents.
    expect(isInsideRoots("C:\\Users\\ivan\\Documents2", ROOTS)).toBe(false);
    expect(isInsideRoots("C:\\Users\\ivan\\DocumentsOld\\x", ROOTS)).toBe(
      false,
    );
  });

  it("регистр на Windows значения не имеет", () => {
    expect(isInsideRoots("c:\\users\\IVAN\\DOCUMENTS\\x", ROOTS)).toBe(true);
  });

  it("разделители обоих видов и хвостовые слэши", () => {
    expect(isInsideRoots("C:/Users/ivan/Documents/x", ROOTS)).toBe(true);
    expect(isInsideRoots("C:\\Users\\ivan\\Documents\\", ROOTS)).toBe(true);
    expect(
      isInsideRoots("C:\\Users\\ivan\\Documents", ["C:/Users/ivan/Documents/"]),
    ).toBe(true);
  });

  it("посторонние места недоступны", () => {
    expect(isInsideRoots("C:\\Windows\\System32", ROOTS)).toBe(false);
    expect(isInsideRoots("D:\\Проекты", ROOTS)).toBe(false);
    expect(isInsideRoots("C:\\Users\\ivan", ROOTS)).toBe(false);
  });

  it("пустые значения не ломают проверку", () => {
    expect(isInsideRoots("", ROOTS)).toBe(false);
    expect(isInsideRoots("   ", ROOTS)).toBe(false);
    expect(isInsideRoots("C:\\Users\\ivan\\Documents", [])).toBe(false);
    expect(isInsideRoots("C:\\Users\\ivan\\Documents", ["", "  "])).toBe(false);
  });

  it("работает и с unix-путями", () => {
    expect(
      isInsideRoots("/home/ivan/Documents/x", ["/home/ivan/Documents"]),
    ).toBe(true);
    expect(isInsideRoots("/home/ivan/Other", ["/home/ivan/Documents"])).toBe(
      false,
    );
  });
});
