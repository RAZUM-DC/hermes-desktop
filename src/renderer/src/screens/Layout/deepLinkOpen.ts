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

/**
 * Whether a failed session load may succeed if simply retried.
 *
 * Errors reach the renderer as "<status>: <body>", usually wrapped by IPC:
 * "Error invoking remote method '…': Error: 503: companion: agent session not
 * ready - /device/session -> HTTP 403 …". Only the first status counts — the
 * inner "HTTP 403" above is the cause of a transient 503, not a final 403.
 * No status at all (network error, timeout, unknown) counts as retryable:
 * on a cold start that is the common case, and the retries are bounded.
 */
export function isRetryableSessionError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const status = /(?:^|Error:\s*)(\d{3}):/.exec(message)?.[1];
  if (!status) return true;
  const code = Number(status);
  return code >= 500 || code === 408 || code === 429;
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
