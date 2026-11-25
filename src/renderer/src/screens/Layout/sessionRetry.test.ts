import { describe, expect, it } from "vitest";
import {
  loadStateAfterFailure,
  RETRY_ATTEMPTS_BEFORE_ADMITTING_FAILURE,
  RETRY_BACKOFF_MS,
  retryDelayMs,
} from "./sessionRetry";

describe("retryDelayMs", () => {
  it("паузы растут по заданной лестнице", () => {
    expect(retryDelayMs(1)).toBe(RETRY_BACKOFF_MS[0]);
    expect(retryDelayMs(2)).toBe(RETRY_BACKOFF_MS[1]);
    expect(retryDelayMs(3)).toBe(RETRY_BACKOFF_MS[2]);
  });

  it("упираются в последнюю ступень и дальше не растут", () => {
    const last = RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
    expect(retryDelayMs(RETRY_BACKOFF_MS.length)).toBe(last);
    expect(retryDelayMs(RETRY_BACKOFF_MS.length + 50)).toBe(last);
    expect(retryDelayMs(10_000)).toBe(last);
  });

  it("края не ломают отсчёт", () => {
    expect(retryDelayMs(0)).toBe(RETRY_BACKOFF_MS[0]);
    expect(retryDelayMs(-5)).toBe(RETRY_BACKOFF_MS[0]);
  });

  it("лестница только возрастает и упирается в минуту", () => {
    for (let i = 1; i < RETRY_BACKOFF_MS.length; i += 1) {
      expect(RETRY_BACKOFF_MS[i]).toBeGreaterThan(RETRY_BACKOFF_MS[i - 1]);
    }
    expect(RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]).toBe(60_000);
  });
});

describe("loadStateAfterFailure", () => {
  it("первые неудачи проходят молча", () => {
    expect(loadStateAfterFailure("loading", 1)).toBe("loading");
    expect(loadStateAfterFailure("loading", 2)).toBe("loading");
  });

  it("после порога говорим прямо", () => {
    expect(
      loadStateAfterFailure("loading", RETRY_ATTEMPTS_BEFORE_ADMITTING_FAILURE),
    ).toBe("failed");
    expect(loadStateAfterFailure("failed", 9)).toBe("failed");
  });

  it("уже показанный список неудача не стирает", () => {
    // Главное свойство: лучше слегка устаревшие чаты, чем пустота на их месте.
    expect(loadStateAfterFailure("ready", 1)).toBe("ready");
    expect(loadStateAfterFailure("ready", 99)).toBe("ready");
  });
});
