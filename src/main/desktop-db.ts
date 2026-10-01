import Database from "better-sqlite3";
import { app } from "electron";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

/**
 * The desktop's own database.
 *
 * Everything the desktop keeps alongside a conversation — images the user
 * attached, the local copy of a transcript, failed-send errors, the context
 * folder — used to live in tables squatting inside the *agent's* state.db.
 * That only works when the agent runs on this machine. In remote mode, where
 * the app talks to a Hermes API server over HTTP, there is no state.db at all:
 * every one of those stores opened a connection, got null, and silently did
 * nothing. Attachments disappeared on restart and the `[screenshot]` marker
 * the agent leaves in the text stayed visible, because the code that strips it
 * is the same code that puts the picture back.
 *
 * This database belongs to the desktop, is created on demand and exists in
 * every connection mode. Rows previously written into the agent's state.db are
 * left where they are; the stores read them as a fallback so nothing already
 * saved is lost.
 */

let cached: Database.Database | null = null;
let cachedPath = "";
// Opening is attempted on every call (a failure can be transient), but the
// complaint is logged once — otherwise a broken install fills the log with
// one identical line per transcript render.
let warned = false;

/** Overridable so tests can point at a temp file without an Electron app. */
export function desktopDbPath(): string {
  const override = process.env.HERMES_DESKTOP_DB_PATH?.trim();
  if (override) return override;
  return join(app.getPath("userData"), "desktop-state.db");
}

export function getDesktopDb(): Database.Database | null {
  let path: string;
  try {
    path = desktopDbPath();
  } catch (err) {
    // app.getPath throws when Electron isn't initialised (unit tests that
    // don't set the override). Callers treat null as "no local storage".
    if (!warned) {
      warned = true;
      console.warn("[desktop-db] cannot resolve path:", err);
    }
    return null;
  }

  if (cached && cachedPath === path) return cached;

  try {
    closeDesktopDb();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const db = new Database(path);
    // WAL keeps the writes from blocking the reads that happen while a
    // transcript is being rendered.
    db.pragma("journal_mode = WAL");
    cached = db;
    cachedPath = path;
    return db;
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn("[desktop-db] unavailable:", err);
    }
    cached = null;
    cachedPath = "";
    return null;
  }
}

export function closeDesktopDb(): void {
  if (!cached) return;
  try {
    cached.close();
  } catch {
    /* already closed */
  }
  cached = null;
  cachedPath = "";
}
