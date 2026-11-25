import type Database from "better-sqlite3";
import { basename, extname } from "path";
import { readFileSync, statSync } from "fs";
import { getDesktopDb } from "./desktop-db";
import type { Attachment } from "../shared/attachments";
import { isImageMime, MAX_IMAGE_BYTES } from "../shared/attachments";

/** Legacy table inside the agent's state.db — read only, never written. */
const TABLE = "desktop_message_attachments";

/**
 * Where prompt images live now.
 *
 * The original table hangs off the agent's own `messages.id`, which means it
 * can only be written when the agent's state.db is on this machine. In remote
 * mode there is no such database, so nothing was ever stored and every picture
 * vanished on restart. This table lives in the desktop's own database and is
 * keyed by what the desktop actually knows in every mode: the session, the
 * normalized prompt text, and which repetition of that text this is (people do
 * send "look" twice). The old table is still read as a fallback so images
 * saved before the move keep showing up.
 */
const PROMPT_TABLE = "desktop_prompt_attachments";

interface StoredAttachmentRow {
  message_id: number;
  ordinal: number;
  name: string;
  mime: string;
  size: number;
  data: Buffer;
}

function tableExists(db: Database.Database, table: string = TABLE): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return !!row;
}

export function stripTrailingImagePlaceholders(text: string): string {
  let out = text || "";
  for (;;) {
    const next = out.replace(/(?:\s*\[(?:screenshot|image)\]\s*)$/i, "");
    if (next === out) return out.trim();
    out = next;
  }
}

const VISION_IMAGE_FALLBACK_RE =
  /^\s*\[The user attached an image(?:\s+but analysis failed\.|:[\s\S]*?)\]\s*\[You can examine it with vision_analyze using image_url:\s*([\s\S]*?)\]\s*/i;

const IMAGE_ATTACHED_AT_RE =
  /(?:^|\r?\n)\s*\[Image attached at:\s*([\s\S]*?)\]\s*(?:\[(?:screenshot|image)\]\s*)*$/i;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function cleanFallbackImagePath(value: string): string {
  return value
    .replace(/\r?\n/g, "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "");
}

export function extractLeadingVisionImageFallback(text: string): {
  content: string;
  imagePath: string | null;
} {
  const raw = text || "";
  const match = VISION_IMAGE_FALLBACK_RE.exec(raw);
  if (match) {
    return {
      content: raw.slice(match[0].length).trimStart(),
      imagePath: cleanFallbackImagePath(match[1] || "") || null,
    };
  }

  const attachedAt = IMAGE_ATTACHED_AT_RE.exec(raw);
  if (attachedAt) {
    return {
      content: `${raw.slice(0, attachedAt.index)}${raw.slice(
        attachedAt.index + attachedAt[0].length,
      )}`.trim(),
      imagePath: cleanFallbackImagePath(attachedAt[1] || "") || null,
    };
  }

  return { content: raw, imagePath: null };
}

export function stripLeadingVisionImageFallback(text: string): string {
  return extractLeadingVisionImageFallback(text).content;
}

export function attachmentFromLocalVisionImagePath(
  filePath: string | null | undefined,
  id: string,
): Attachment | null {
  if (!filePath || filePath.startsWith("data:")) return null;
  const ext = extname(filePath).toLowerCase();
  const mime = IMAGE_MIME_BY_EXT[ext];
  if (!mime || !isImageMime(mime)) return null;

  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
      return null;
    }
    const data = readFileSync(filePath);
    if (data.length <= 0 || data.length > MAX_IMAGE_BYTES) return null;
    return {
      id,
      kind: "image",
      name: basename(filePath) || `image${ext}`,
      mime,
      size: data.length,
      dataUrl: `data:${mime};base64,${data.toString("base64")}`,
      path: filePath,
    };
  } catch {
    return null;
  }
}

function normalizedPromptText(text: string): string {
  return stripTrailingImagePlaceholders(stripLeadingVisionImageFallback(text))
    .replace(/\s+/g, " ")
    .trim();
}

function parseImageDataUrl(
  dataUrl: string,
): { mime: string; data: Buffer } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl || "");
  if (!match) return null;
  const mime = match[1].toLowerCase();
  if (!isImageMime(mime)) return null;
  const data = Buffer.from(match[2], "base64");
  if (data.length <= 0 || data.length > MAX_IMAGE_BYTES) return null;
  return { mime, data };
}

function imageAttachments(attachments?: Attachment[]): Attachment[] {
  return (attachments || []).filter(
    (a) => a.kind === "image" && typeof a.dataUrl === "string",
  );
}

function ensurePromptTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PROMPT_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt_key TEXT NOT NULL,
      occurrence INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      data BLOB NOT NULL,
      created_at REAL NOT NULL DEFAULT (strftime('%s', 'now')),
      UNIQUE(session_id, prompt_key, occurrence, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_${PROMPT_TABLE}_session
      ON ${PROMPT_TABLE}(session_id);
  `);
}

interface StoredPromptRow {
  prompt_key: string;
  occurrence: number;
  ordinal: number;
  name: string;
  mime: string;
  size: number;
  data: Buffer;
}

/**
 * The key a stored image is filed under: the prompt text with the agent's
 * `[screenshot]` / `[image]` markers and vision fallbacks stripped, whitespace
 * collapsed. Exported because the merge step has to compute the same key from
 * a transcript that came back from the agent.
 */
export function promptAttachmentKey(text: string): string {
  return normalizedPromptText(text || "");
}

/**
 * Images for one session, as `prompt key -> occurrence -> attachments`.
 */
export function loadPromptAttachmentsBySession(
  sessionId: string,
): Map<string, Attachment[][]> {
  const byPrompt = new Map<string, Attachment[][]>();
  if (!sessionId) return byPrompt;
  const db = getDesktopDb();
  if (!db || !tableExists(db, PROMPT_TABLE)) return byPrompt;

  const rows = db
    .prepare(
      `SELECT prompt_key, occurrence, ordinal, name, mime, size, data
       FROM ${PROMPT_TABLE}
       WHERE session_id = ?
       ORDER BY occurrence, ordinal`,
    )
    .all(sessionId) as StoredPromptRow[];

  for (const row of rows) {
    if (!isImageMime(row.mime)) continue;
    const occurrences = byPrompt.get(row.prompt_key) || [];
    const bucket = occurrences[row.occurrence] || [];
    bucket.push({
      id: `prompt-att-${row.prompt_key}-${row.occurrence}-${row.ordinal}`,
      kind: "image",
      name: row.name,
      mime: row.mime,
      size: row.size,
      dataUrl: `data:${row.mime};base64,${Buffer.from(row.data).toString("base64")}`,
    });
    occurrences[row.occurrence] = bucket;
    byPrompt.set(row.prompt_key, occurrences);
  }

  return byPrompt;
}

export function deletePromptAttachmentsForSession(sessionId: string): void {
  const db = getDesktopDb();
  if (!db || !tableExists(db, PROMPT_TABLE)) return;
  db.prepare(`DELETE FROM ${PROMPT_TABLE} WHERE session_id = ?`).run(sessionId);
}

/**
 * Store the images that went out with a prompt, so re-opening the conversation
 * can put them back. The agent's transcript keeps only text (with a
 * `[screenshot]` marker where the picture was), so without this the pictures
 * are gone the moment the app restarts.
 */
export function persistPromptImageAttachments(
  sessionId: string | undefined,
  promptText: string,
  attachments?: Attachment[],
): void {
  if (!sessionId) return;
  const images = imageAttachments(attachments);
  if (images.length === 0) return;

  const db = getDesktopDb();
  if (!db) return;

  ensurePromptTable(db);
  const key = promptAttachmentKey(promptText);

  // The same prompt text can be sent more than once in a session ("look at
  // this" twice, or an empty prompt with just a picture), so each send gets
  // the next free slot under that key.
  const seen = db
    .prepare(
      `SELECT COALESCE(MAX(occurrence), -1) AS last
       FROM ${PROMPT_TABLE} WHERE session_id = ? AND prompt_key = ?`,
    )
    .get(sessionId, key) as { last: number } | undefined;
  const occurrence = (seen?.last ?? -1) + 1;

  const insert = db.prepare(
    `INSERT OR REPLACE INTO ${PROMPT_TABLE}
     (session_id, prompt_key, occurrence, ordinal, name, mime, size, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    images.forEach((attachment, index) => {
      const parsed = parseImageDataUrl(attachment.dataUrl || "");
      if (!parsed) return;
      insert.run(
        sessionId,
        key,
        occurrence,
        index,
        attachment.name || `image-${index + 1}`,
        parsed.mime,
        attachment.size || parsed.data.length,
        parsed.data,
      );
    });
  });
  tx();
}

export function loadPromptImageAttachments(
  db: Database.Database,
  sessionId: string,
): Map<number, Attachment[]> {
  const byMessageId = new Map<number, Attachment[]>();
  if (!tableExists(db)) return byMessageId;

  const rows = db
    .prepare(
      `SELECT message_id, ordinal, name, mime, size, data
       FROM ${TABLE}
       WHERE session_id = ? AND kind = 'image'
       ORDER BY message_id, ordinal`,
    )
    .all(sessionId) as StoredAttachmentRow[];

  for (const row of rows) {
    if (!isImageMime(row.mime)) continue;
    const bucket = byMessageId.get(row.message_id) || [];
    bucket.push({
      id: `db-att-${row.message_id}-${row.ordinal}`,
      kind: "image",
      name: row.name,
      mime: row.mime,
      size: row.size,
      dataUrl: `data:${row.mime};base64,${Buffer.from(row.data).toString("base64")}`,
    });
    byMessageId.set(row.message_id, bucket);
  }

  return byMessageId;
}

export function deletePromptImageAttachmentsForSession(
  db: Database.Database,
  sessionId: string,
): void {
  if (!tableExists(db)) return;
  db.prepare(`DELETE FROM ${TABLE} WHERE session_id = ?`).run(sessionId);
}
