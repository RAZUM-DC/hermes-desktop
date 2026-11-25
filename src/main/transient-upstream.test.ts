import { describe, expect, it, vi } from "vitest";
import { isTransientUpstream, retryWhileNotReady } from "./transient-upstream";

describe("isTransientUpstream", () => {
  it("узнаёт неготовый companion", () => {
    expect(
      isTransientUpstream(new Error("503: companion: agent session not ready")),
    ).toBe(true);
    expect(isTransientUpstream(new Error("502: bad gateway"))).toBe(true);
    expect(
      isTransientUpstream(new Error("connect ECONNREFUSED 127.0.0.1:18644")),
    ).toBe(true);
    expect(isTransientUpstream(new Error("socket hang up"))).toBe(true);
  });

  it("не считает временным отказ в правах и прочие 4xx", () => {
    // Главное свойство: 403 от шима повторами не лечится, долбить его нельзя.
    expect(isTransientUpstream(new Error("403: shim: forbidden"))).toBe(false);
    expect(isTransientUpstream(new Error("401: unauthorized"))).toBe(false);
    expect(isTransientUpstream(new Error("422: Unprocessable Entity"))).toBe(
      false,
    );
    expect(isTransientUpstream(new Error("404: Not Found"))).toBe(false);
  });

  it("не путается в номерах внутри текста", () => {
    // 503 распознаётся только в начале сообщения — там его ставит наш код.
    expect(isTransientUpstream(new Error("session 50319 missing"))).toBe(false);
    expect(isTransientUpstream(new Error("bad json at offset 502"))).toBe(
      false,
    );
  });

  it("пустое и незнакомое временным не считает", () => {
    expect(isTransientUpstream(null)).toBe(false);
    expect(isTransientUpstream(new Error(""))).toBe(false);
    expect(isTransientUpstream(new Error("Invalid JSON from ..."))).toBe(false);
  });
});

describe("retryWhileNotReady", () => {
  const noSleep = (): Promise<void> => Promise.resolve();

  it("возвращает результат первой удачной попытки", async () => {
    const attempt = vi.fn().mockResolvedValue("готово");
    await expect(retryWhileNotReady(attempt, [1, 2], noSleep)).resolves.toBe(
      "готово",
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("повторяет, пока companion не поднимется", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("503: companion: agent session not ready"),
      )
      .mockRejectedValueOnce(
        new Error("503: companion: agent session not ready"),
      )
      .mockResolvedValue({ sessions: [1, 2, 3] });
    await expect(
      retryWhileNotReady(attempt, [1, 2, 3], noSleep),
    ).resolves.toEqual({ sessions: [1, 2, 3] });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("постоянную ошибку не повторяет вовсе", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new Error("403: shim: forbidden"));
    await expect(retryWhileNotReady(attempt, [1, 2], noSleep)).rejects.toThrow(
      "403: shim: forbidden",
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("сдаётся после последней задержки и пробрасывает ошибку", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new Error("503: companion: agent session not ready"));
    await expect(retryWhileNotReady(attempt, [1, 2], noSleep)).rejects.toThrow(
      "agent session not ready",
    );
    // Попыток на одну больше, чем задержек: первая идёт без паузы.
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("выдерживает паузы именно той длины, что заданы", async () => {
    const waited: number[] = [];
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("503: x"))
      .mockRejectedValueOnce(new Error("503: x"))
      .mockResolvedValue("ок");
    await retryWhileNotReady(attempt, [300, 700, 1500], async (ms) => {
      waited.push(ms);
    });
    expect(waited).toEqual([300, 700]);
  });
});
