import { describe, expect, it, vi } from "vitest";
import {
  classifySessionError,
  latestAfterCancelLink,
  openSessionWithRetry,
  pendingLinkOnResume,
  resolveResumeLoad,
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

describe("classifySessionError", () => {
  it.each([
    "Error invoking remote method 'get-session-messages': Error: 503: companion: agent session not ready - /device/session -> HTTP 403: {}",
    "502: Bad Gateway",
    "Error: 429: slow down",
    "Error: 408: timeout",
    "connect ECONNREFUSED 127.0.0.1:18644",
    "Remote request timed out after 15000ms",
    "Invalid JSON from https://x/api (status 200): <html>",
  ])("retries %s", (message) => {
    expect(classifySessionError(new Error(message))).toBe("retryable");
  });

  it("maps 404 to «not found»", () => {
    expect(
      classifySessionError(
        new Error(
          'Error invoking remote method \'get-session-messages\': Error: 404: {"detail":"Session not found"}',
        ),
      ),
    ).toBe("notFound");
  });

  it.each(["Error: 403: forbidden", "400: bad request", "401: no token"])(
    "treats %s as final",
    (message) => {
      expect(classifySessionError(new Error(message))).toBe("failed");
    },
  );

  it("handles non-Error values", () => {
    expect(classifySessionError(undefined)).toBe("retryable");
    expect(classifySessionError("404: x")).toBe("notFound");
  });
});

describe("resolveResumeLoad", () => {
  const base = {
    sessionId: "a",
    latest: "a" as string | null,
    quiet: false,
    requireExisting: false,
  };

  it("opens a loaded session", () => {
    expect(resolveResumeLoad({ ...base, result: { items: [1] } })).toEqual({
      outcome: "opened",
      items: [1],
      error: null,
    });
  });

  it("drops a load another request superseded, whatever its result", () => {
    for (const result of [{ items: [1] }, { error: new Error("503: x") }])
      expect(resolveResumeLoad({ ...base, latest: "b", result }).outcome).toBe(
        "superseded",
      );
    expect(
      resolveResumeLoad({ ...base, latest: null, result: { items: [] } }),
    ).toEqual({ outcome: "superseded", error: null });
  });

  it("keeps a retryable error quiet only on a quiet attempt", () => {
    const result = { error: new Error("503: not ready") };
    expect(resolveResumeLoad({ ...base, quiet: true, result })).toEqual({
      outcome: "retryable",
      error: null,
    });
    expect(resolveResumeLoad({ ...base, result })).toEqual({
      outcome: "retryable",
      error: { sessionId: "a", kind: "failed", requireExisting: false },
    });
  });

  it("shows final errors at once, even on a quiet attempt", () => {
    expect(
      resolveResumeLoad({
        ...base,
        quiet: true,
        requireExisting: true,
        result: { error: new Error("404: gone") },
      }),
    ).toEqual({
      outcome: "failed",
      error: { sessionId: "a", kind: "notFound", requireExisting: true },
    });
    expect(
      resolveResumeLoad({
        ...base,
        quiet: true,
        result: { error: new Error("403: no") },
      }).error?.kind,
    ).toBe("failed");
  });

  it("treats an empty history as «not found» only when the id must exist", () => {
    expect(
      resolveResumeLoad({
        ...base,
        requireExisting: true,
        result: { items: [] },
      }),
    ).toEqual({
      outcome: "failed",
      error: { sessionId: "a", kind: "notFound", requireExisting: true },
    });
    expect(resolveResumeLoad({ ...base, result: { items: [] } }).outcome).toBe(
      "opened",
    );
  });

  it("carries requireExisting into the banner so Retry keeps the check", () => {
    const d = resolveResumeLoad({
      ...base,
      requireExisting: true,
      result: { error: new Error("ECONNRESET") },
    });
    expect(d.error).toEqual({
      sessionId: "a",
      kind: "failed",
      requireExisting: true,
    });
  });
});

describe("«Opening…» banner ownership", () => {
  it("survives only its own link's resume", () => {
    expect(pendingLinkOnResume("a", "a")).toBe("a");
    expect(pendingLinkOnResume("a", "b")).toBeNull();
    expect(pendingLinkOnResume(null, "b")).toBeNull();
  });

  it("Cancel gives up only the pending link, not a newer request", () => {
    expect(latestAfterCancelLink("a", "a")).toBeNull();
    expect(latestAfterCancelLink("b", "a")).toBe("b");
    expect(latestAfterCancelLink("b", null)).toBe("b");
    expect(latestAfterCancelLink(null, "a")).toBeNull();
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
