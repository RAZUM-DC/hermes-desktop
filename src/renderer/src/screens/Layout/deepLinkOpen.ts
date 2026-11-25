// Opening a session from a deep link (razum-assistant://session/<id>).
//
// A link often arrives on a cold start: Layout is mounted, but the remote
// transport (companion → agent JWT) may still be coming up, so the first load
// can fail for a reason that fixes itself within seconds. Only such transient
// failures are retried; "not found" / "forbidden" are final at once.
//
//   attempt ──opened──────────────► done (true)
//      │ ──failed (final)─────────► stop; the attempt itself showed the error
//      │ ──superseded─────────────► stop (newer resume / new chat / tab / nav)
//      └─retryable─► waiting (indicator on) ─► still current? ─► next attempt
//                                               └─ no ─► stop
//   The last attempt is not quiet: a retryable failure there shows the error.
//
// Pure: the actual resume and the "is this still the current request" check
// are injected, so the state machine is unit-tested without React.

export const DEEP_LINK_RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 10000];

/** Result of one attempt to put a session on screen. */
export type ResumeOutcome =
  /** The session is on screen (loaded now, already open, or loading already). */
  | "opened"
  /** Worth retrying: transport not ready, network, timeout, 5xx/408/429. */
  | "retryable"
  /** Final: not found, forbidden, bad request… The error is already shown. */
  | "failed"
  /** Another request took over the screen meanwhile. */
  | "superseded";

/** How a failed session load should be treated. */
export type SessionErrorClass = "retryable" | "notFound" | "failed";

/**
 * Classifies a failed session load.
 *
 * Errors reach the renderer as "<status>: <body>", usually wrapped by IPC:
 * "Error invoking remote method '…': Error: 503: companion: agent session not
 * ready - /device/session -> HTTP 403 …". Only the first status counts — the
 * inner "HTTP 403" above is the cause of a transient 503, not a final 403.
 *
 *   no status (network, timeout, unknown) → retryable: the common cold-start
 *                                           case; the retries are bounded
 *   5xx, 408, 429                         → retryable
 *   404                                   → notFound
 *   other 4xx                             → failed
 */
export function classifySessionError(err: unknown): SessionErrorClass {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const status = /(?:^|Error:\s*)(\d{3}):/.exec(message)?.[1];
  if (!status) return "retryable";
  const code = Number(status);
  if (code >= 500 || code === 408 || code === 429) return "retryable";
  if (code === 404) return "notFound";
  return "failed";
}

/** The «could not open» banner: which session, why, and how to retry it. */
export interface ResumeErrorState {
  sessionId: string;
  kind: "notFound" | "failed";
  /** Retry must keep the «must exist» check of the original request (links). */
  requireExisting: boolean;
}

export type ResumeLoadResult<T> = { items: readonly T[] } | { error: unknown };

export type ResumeDecision<T> =
  | { outcome: "opened"; items: readonly T[]; error: null }
  | {
      outcome: Exclude<ResumeOutcome, "opened">;
      error: ResumeErrorState | null;
    };

/**
 * What to do with a finished session load (handleResumeSession).
 *
 *   another request owns the screen        → superseded, nothing shown
 *   error, retryable, quiet attempt        → retryable, nothing shown (the
 *                                            caller retries)
 *   error, retryable, loud attempt         → retryable + «failed» banner
 *   error, 404                             → failed + «not found» banner
 *   error, other                           → failed + «failed» banner
 *   empty history and requireExisting      → failed + «not found» banner: a
 *                                            linked id with no history is no
 *                                            session here; opening it would
 *                                            bind an empty chat to a foreign id
 *   otherwise                              → opened
 */
export function resolveResumeLoad<T>(input: {
  sessionId: string;
  latest: string | null;
  quiet: boolean;
  requireExisting: boolean;
  result: ResumeLoadResult<T>;
}): ResumeDecision<T> {
  const { sessionId, quiet, requireExisting, result } = input;
  if (input.latest !== sessionId) return { outcome: "superseded", error: null };
  const banner = (kind: ResumeErrorState["kind"]): ResumeErrorState => ({
    sessionId,
    kind,
    requireExisting,
  });
  if ("error" in result) {
    const cls = classifySessionError(result.error);
    if (cls === "retryable")
      return { outcome: "retryable", error: quiet ? null : banner("failed") };
    return { outcome: "failed", error: banner(cls) };
  }
  if (requireExisting && result.items.length === 0)
    return { outcome: "failed", error: banner("notFound") };
  return { outcome: "opened", items: result.items, error: null };
}

/**
 * «Opening the conversation from the link…» banner when a resume starts: it
 * stays only if this resume is that same link's; any other request takes the
 * screen, so the banner (and the link's retries) are no longer relevant.
 */
export function pendingLinkOnResume(
  pending: string | null,
  sessionId: string,
): string | null {
  return pending === sessionId ? pending : null;
}

/**
 * «Cancel» on the «Opening…» banner: give up only that link. If another
 * request already owns the screen, leave it alone (its load must not be
 * reported as superseded).
 */
export function latestAfterCancelLink(
  latest: string | null,
  pending: string | null,
): string | null {
  return pending !== null && latest === pending ? null : latest;
}

export interface OpenSessionWithRetryOptions {
  sessionId: string;
  /** One attempt; quiet = don't show the error for a retryable failure. */
  resume: (sessionId: string, quiet: boolean) => Promise<ResumeOutcome>;
  /** False once another request took over the screen. */
  isCurrent: (sessionId: string) => boolean;
  /** Called with true when a retry wait starts and with false when the loop ends. */
  onWaiting?: (waiting: boolean) => void;
  sleep?: (ms: number) => Promise<void>;
  delays?: readonly number[];
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves true if the session was opened, false if it failed or was superseded. */
export async function openSessionWithRetry(
  opts: OpenSessionWithRetryOptions,
): Promise<boolean> {
  const delays = opts.delays ?? DEEP_LINK_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? defaultSleep;
  let waited = false;
  try {
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) {
        waited = true;
        opts.onWaiting?.(true);
        await sleep(delays[attempt - 1]);
        if (!opts.isCurrent(opts.sessionId)) return false;
      }
      const last = attempt === delays.length;
      let outcome: ResumeOutcome;
      try {
        outcome = await opts.resume(opts.sessionId, !last);
      } catch {
        outcome = "retryable";
      }
      if (outcome === "opened") return true;
      if (outcome !== "retryable") return false;
      if (!opts.isCurrent(opts.sessionId)) return false;
    }
    return false;
  } finally {
    if (waited) opts.onWaiting?.(false);
  }
}
