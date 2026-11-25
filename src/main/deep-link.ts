// Deep links `razum-assistant://session/<id>` — the only supported action is
// opening an existing Hermes session. Everything here is pure (no Electron
// imports) so it can be unit-tested; wiring lives in app/start.ts.

export const DEEP_LINK_PROTOCOL = "razum-assistant";
export const DEEP_LINK_OPEN_SESSION_CHANNEL = "deep-link-open-session";
export const DEEP_LINK_READY_CHANNEL = "deep-link-renderer-ready";
export const DEEP_LINK_GONE_CHANNEL = "deep-link-renderer-gone";
export const DEEP_LINK_ACK_CHANNEL = "deep-link-ack";

// Whitelist: scheme + host `session` + exactly one path segment (an optional
// trailing slash is tolerated, browsers/Windows append it). No query, hash,
// credentials, port, percent-encoding or extra segments — the id is matched on
// the raw string and never decoded.
const SESSION_LINK_RE =
  /^razum-assistant:\/\/session\/([A-Za-z0-9_-]{1,128})\/?$/i;

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
 * How to call app.setAsDefaultProtocolClient (or whether to call it at all).
 *
 *   packaged, installed  → "default": Electron writes process.execPath — the
 *                           installed exe;
 *   packaged, portable   → "explicit" with the real portable .exe
 *                           (PORTABLE_EXECUTABLE_FILE). process.execPath points
 *                           into the temp folder the portable unpacks to and
 *                           deletes on exit — registering it would break links
 *                           for every build on the machine;
 *   dev (`electron .`)   → "skip", unless explicitly opted in: otherwise every
 *                           `npm run dev` hijacks the scheme from the installed
 *                           app. Opted in → electron + the app path, or a bare
 *                           Electron shell would start.
 */
export type ProtocolRegistration =
  | { kind: "skip" }
  | { kind: "default" }
  | { kind: "explicit"; path: string; args: string[] };

export function buildProtocolRegistration(opts: {
  defaultApp: boolean;
  execPath: string;
  argv: readonly string[];
  resolvePath: (p: string) => string;
  portableExecutable?: string;
  registerInDev?: boolean;
}): ProtocolRegistration {
  if (opts.defaultApp) {
    if (!opts.registerInDev || opts.argv.length < 2) return { kind: "skip" };
    return {
      kind: "explicit",
      path: opts.execPath,
      args: [opts.resolvePath(opts.argv[1])],
    };
  }
  const portable = opts.portableExecutable?.trim();
  if (portable) return { kind: "explicit", path: portable, args: [] };
  return { kind: "default" };
}

/** One delivery attempt of a link to the renderer; seq identifies the link. */
export interface DeepLinkDelivery {
  sessionId: string;
  seq: number;
}

/**
 * Delivers links to the renderer with acknowledgement.
 *
 *   enqueue(id) ─► pending = {id, seq+1} (only the latest click matters)
 *                   └─ ready? send now
 *   markReady()  ─► ready; pending not acked yet? send (again)
 *   ack(seq)     ─► the renderer took that link: drop it if still pending
 *   markNotReady ─► stop sending until the next ready (unsubscribed, crashed,
 *                   window closed)
 *
 * A link is dropped only after the renderer confirms it. A send that lands in
 * a page being reloaded, or any other gap the ready/not-ready signals miss,
 * just stays pending and is re-sent on the next ready — so delivery does not
 * depend on catching every navigation event. A re-send of a link the renderer
 * already took is recognised by its seq and only acknowledged again.
 */
export interface DeepLinkDispatcher {
  enqueue(sessionId: string): void;
  markReady(): void;
  markNotReady(): void;
  ack(seq: number): void;
}

export function createDeepLinkDispatcher(
  send: (delivery: DeepLinkDelivery) => void,
): DeepLinkDispatcher {
  let ready = false;
  let seq = 0;
  let pending: DeepLinkDelivery | null = null;
  return {
    enqueue(sessionId) {
      pending = { sessionId, seq: ++seq };
      if (ready) send(pending);
    },
    markReady() {
      ready = true;
      if (pending) send(pending);
    },
    markNotReady() {
      ready = false;
    },
    ack(ackSeq) {
      if (pending && pending.seq === ackSeq) pending = null;
    },
  };
}
