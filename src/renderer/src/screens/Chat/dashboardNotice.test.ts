import { beforeEach, describe, expect, it } from "vitest";
import {
  claimFallbackNotice,
  forgetFallbackNotice,
  noticeSignature,
} from "./dashboardNotice";

function fakeStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function throwingStorage(): Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
> {
  return {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
}

describe("память об уведомлении", () => {
  let storage = fakeStorage();
  beforeEach(() => {
    storage = fakeStorage();
  });

  it("показывает один раз для одного и того же отказа", () => {
    const sig = noticeSignature("remote", "403: shim: forbidden");
    expect(claimFallbackNotice(sig, storage)).toBe(true);
    expect(claimFallbackNotice(sig, storage)).toBe(false);
  });

  it("другой отказ показывается заново", () => {
    const first = noticeSignature("remote", "403: shim: forbidden");
    const second = noticeSignature("remote", "WebSocket upgrade failed");
    expect(claimFallbackNotice(first, storage)).toBe(true);
    expect(claimFallbackNotice(second, storage)).toBe(true);
  });

  it("тот же отказ в другом режиме подключения показывается заново", () => {
    expect(claimFallbackNotice(noticeSignature("remote", "403"), storage)).toBe(
      true,
    );
    expect(claimFallbackNotice(noticeSignature("ssh", "403"), storage)).toBe(
      true,
    );
  });

  it("сброс возвращает плашку", () => {
    const sig = noticeSignature("remote", "403");
    expect(claimFallbackNotice(sig, storage)).toBe(true);
    expect(claimFallbackNotice(sig, storage)).toBe(false);
    forgetFallbackNotice(storage);
    expect(claimFallbackNotice(sig, storage)).toBe(true);
  });

  it("недоступное хранилище не заставляет молчать", () => {
    const sig = noticeSignature("remote", "403");
    const blocked = throwingStorage();
    expect(claimFallbackNotice(sig, blocked)).toBe(true);
    expect(claimFallbackNotice(sig, blocked)).toBe(true);
  });

  it("лишние пробелы в причине не создают новый случай", () => {
    expect(noticeSignature("remote", " 403 ")).toBe(
      noticeSignature("remote", "403"),
    );
  });
});
