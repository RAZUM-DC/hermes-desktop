import { describe, expect, it, vi } from "vitest";
import { openSessionWithRetry } from "./deepLinkOpen";

const noSleep = (): Promise<void> => Promise.resolve();

describe("openSessionWithRetry", () => {
  it("opens on the first try without waiting", async () => {
    const resume = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn(noSleep);
    await expect(
      openSessionWithRetry({
        sessionId: "a",
        resume,
        isCurrent: () => true,
        sleep,
        delays: [1, 2],
      }),
    ).resolves.toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith("a", true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries quietly and reports only the last failure", async () => {
    const resume = vi.fn().mockResolvedValue(false);
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
    expect(resume.mock.calls).toEqual([
      ["a", true],
      ["a", true],
      ["a", false],
    ]);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it("succeeds on a retry once the transport is up", async () => {
    const resume = vi
      .fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce(true);
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

  it("stops when another request took over while waiting", async () => {
    let current = true;
    const resume = vi.fn().mockResolvedValue(false);
    const sleep = vi.fn(async () => {
      current = false; // e.g. the user clicked «New chat» meanwhile
    });
    await expect(
      openSessionWithRetry({
        sessionId: "a",
        resume,
        isCurrent: () => current,
        sleep,
        delays: [10, 20],
      }),
    ).resolves.toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("does not retry a load that was superseded", async () => {
    const resume = vi.fn().mockResolvedValue(false);
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
