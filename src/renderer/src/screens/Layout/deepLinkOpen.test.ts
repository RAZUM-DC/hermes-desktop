import { describe, expect, it, vi } from "vitest";
import {
  isRetryableSessionError,
  openSessionWithRetry,
  type ResumeOutcome,
} from "./deepLinkOpen";

const noSleep = (): Promise<void> => Promise.resolve();
type ResumeMock = ReturnType<
  typeof vi.fn<(id: string, quiet: boolean) => Promise<ResumeOutcome>>
>;
const outcomes = (...list: ResumeOutcome[]): ResumeMock => {
  const fn = vi.fn<(id: string, quiet: boolean) => Promise<ResumeOutcome>>();
  for (const o of list) fn.mockResolvedValueOnce(o);
  return fn;
};

describe("isRetryableSessionError", () => {
  it.each([
    "Error invoking remote method 'get-session-messages': Error: 503: companion: agent session not ready - /device/session -> HTTP 403: {}",
    "502: Bad Gateway",
    "Error: 429: slow down",
    "Error: 408: timeout",
    "connect ECONNREFUSED 127.0.0.1:18644",
    "Remote request timed out after 15000ms",
  ])("retries %s", (message) => {
    expect(isRetryableSessionError(new Error(message))).toBe(true);
  });

  it.each([
    "Error invoking remote method 'get-session-messages': Error: 404: not found",
    "Error: 403: forbidden",
    "400: bad request",
  ])("does not retry %s", (message) => {
    expect(isRetryableSessionError(new Error(message))).toBe(false);
  });

  it("treats non-Error values as retryable", () => {
    expect(isRetryableSessionError(undefined)).toBe(true);
    expect(isRetryableSessionError("404: x")).toBe(false);
  });
});

describe("openSessionWithRetry", () => {
  it("opens on the first try without waiting", async () => {
    const resume = outcomes("opened");
    const onWaiting = vi.fn();
    const sleep = vi.fn(noSleep);
    await expect(
      openSessionWithRetry({
        sessionId: "a",
        resume,
        isCurrent: () => true,
        onWaiting,
        sleep,
        delays: [1, 2],
      }),
    ).resolves.toBe(true);
    expect(resume.mock.calls).toEqual([["a", true]]);
    expect(sleep).not.toHaveBeenCalled();
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it("retries quietly and makes only the last attempt loud", async () => {
    const resume = outcomes("retryable", "retryable", "retryable");
    const onWaiting = vi.fn();
    const sleep = vi.fn(noSleep);
    await expect(
      openSessionWithRetry({
        sessionId: "a",
        resume,
        isCurrent: () => true,
        onWaiting,
        sleep,
        delays: [10, 20],
      }),
    ).resolves.toBe(false);
    expect(resume.mock.calls).toEqual([
      ["a", true],
      ["a", true],
      ["a", false],
    ]);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
    // Indicator: on for each wait, off once at the end.
    expect(onWaiting.mock.calls).toEqual([[true], [true], [false]]);
  });

  it("succeeds on a retry once the transport is up", async () => {
    const resume = outcomes("retryable", "opened");
    await expect(
      openSessionWithRetry({
        sessionId: "a",
        resume,
        isCurrent: () => true,
        sleep: noSleep,
        delays: [10, 20],
      }),
    ).resolves.toBe(true);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("treats a thrown attempt as retryable", async () => {
    const resume = vi
      .fn<(id: string, quiet: boolean) => Promise<ResumeOutcome>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("opened");
    await expect(
      openSessionWithRetry({
        sessionId: "a",
        resume,
        isCurrent: () => true,
        sleep: noSleep,
        delays: [10],
      }),
    ).resolves.toBe(true);
  });

  it.each(["failed", "superseded"] as const)(
    "stops at once on %s",
    async (outcome) => {
      const resume = outcomes(outcome);
      const sleep = vi.fn(noSleep);
      await expect(
        openSessionWithRetry({
          sessionId: "a",
          resume,
          isCurrent: () => true,
          sleep,
          delays: [10, 20],
        }),
      ).resolves.toBe(false);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("stops when another request took over while waiting", async () => {
    let current = true;
    const resume = outcomes("retryable", "opened");
    const onWaiting = vi.fn();
    const sleep = vi.fn(async () => {
      current = false; // e.g. the user clicked «New chat» or «Cancel»
    });
    await expect(
      openSessionWithRetry({
        sessionId: "a",
        resume,
        isCurrent: () => current,
        onWaiting,
        sleep,
        delays: [10, 20],
      }),
    ).resolves.toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(onWaiting.mock.calls).toEqual([[true], [false]]);
  });

  it("does not retry a load that was superseded mid-flight", async () => {
    const resume = outcomes("retryable");
    const sleep = vi.fn(noSleep);
    await expect(
      openSessionWithRetry({
        sessionId: "a",
        resume,
        isCurrent: () => false,
        sleep,
        delays: [10],
      }),
    ).resolves.toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
