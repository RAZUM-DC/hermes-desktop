// Deep links `razum-assistant://session/<id>` — the only supported action is
// opening an existing Hermes session. Everything here is pure (no Electron
// imports) so it can be unit-tested; wiring lives in app/start.ts.

export const DEEP_LINK_PROTOCOL = "razum-assistant";
export const DEEP_LINK_OPEN_SESSION_CHANNEL = "deep-link:open-session";
export const DEEP_LINK_READY_CHANNEL = "deep-link:renderer-ready";
export const DEEP_LINK_GONE_CHANNEL = "deep-link:renderer-gone";

// Whitelist: scheme + host `session` + exactly one path segment (an optional
// trailing slash is tolerated, browsers/Windows append it). No query, hash,
// credentials, port, percent-encoding or extra segments — the id is matched on
// the raw string and never decoded.
const SESSION_LINK_RE = /^razum-assistant:\/\/session\/([A-Za-z0-9_-]{1,128})\/?$/i;

export type DeepLinkAction = { type: "open-session"; sessionId: string };

export function parseDeepLink(raw: unknown): DeepLinkAction | null {
  if (typeof raw !== "string" || raw.length > 256) return null;
  const match = SESSION_LINK_RE.exec(raw.trim());
  if (!match) return null;
  return { type: "open-session", sessionId: match[1] };
}

/** Picks the first argv entry that looks like a deep link (Windows/Linux). */
export function pickDeepLinkFromArgv(argv: readonly string[]): string | null {
  const prefix = `${DEEP_LINK_PROTOCOL}://`;
  for (const entry of argv) {
    if (typeof entry !== "string") continue;
    const arg = entry.trim().replace(/^["']+|["']+$/g, "");
    if (arg.toLowerCase().startsWith(prefix)) return arg;
  }
  return null;
}

/**
 * Arguments for app.setAsDefaultProtocolClient. In dev (`electron .`) the
 * registry entry must launch electron with the app path, otherwise it would
 * start a bare Electron shell.
 */
export function buildProtocolRegistration(opts: {
  defaultApp: boolean;
  execPath: string;
  argv: readonly string[];
  resolvePath: (p: string) => string;
}): { path: string; args: string[] } | null {
  if (!opts.defaultApp) return null;
  if (opts.argv.length < 2) return null;
  return { path: opts.execPath, args: [opts.resolvePath(opts.argv[1])] };
}

export interface DeepLinkDispatcher {
  /** Deliver now if the renderer is ready, otherwise keep the latest id. */
  enqueue(sessionId: string): void;
  /** Renderer subscribed: flush the pending id (if any) and send directly after. */
  markReady(): void;
  /** Renderer reloaded/unmounted: buffer again. */
  markNotReady(): void;
}

export function createDeepLinkDispatcher(
  send: (sessionId: string) => void,
): DeepLinkDispatcher {
  let ready = false;
  let pending: string | null = null;
  return {
    enqueue(sessionId) {
      if (ready) send(sessionId);
      else pending = sessionId; // only the most recent click matters
    },
    markReady() {
      ready = true;
      if (pending !== null) {
        const id = pending;
        pending = null;
        send(id);
      }
    },
    markNotReady() {
      ready = false;
    },
  };
}
