// Opening a session from a deep link (razum-assistant://session/<id>).
//
// A link often arrives on a cold start: Layout is mounted, but the remote
// transport (companion → agent JWT) may still be coming up, so the first load
// can fail for a reason that fixes itself within seconds. Hence a few quiet
// retries before the user is shown an error.
//
//   attempt 0 ──fail──► wait 2 s ──► attempt 1 ──fail──► wait 5 s ──► …
//      │                   │                                  last attempt:
//      ok → done           └─ superseded (newer resume,          not quiet,
//                             new chat, tab click) → stop        error shown
//
// Pure: the actual resume and the "is this still the current request" check
// are injected, so the state machine is unit-tested without React.

export const DEEP_LINK_RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 10000];

export interface OpenSessionWithRetryOptions {
  sessionId: string;
  /** Resolves true when the session is on screen; quiet = don't show an error. */
  resume: (sessionId: string, quiet: boolean) => Promise<boolean>;
  /** False once another request took over the screen. */
  isCurrent: (sessionId: string) => boolean;
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
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      await sleep(delays[attempt - 1]);
      if (!opts.isCurrent(opts.sessionId)) return false;
    }
    const last = attempt === delays.length;
    let ok = false;
    try {
      ok = await opts.resume(opts.sessionId, !last);
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (!opts.isCurrent(opts.sessionId)) return false;
  }
  return false;
}
