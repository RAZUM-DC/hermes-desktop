import { getDesktopDb } from "./desktop-db";

/**
 * Диалоги, которым приложение уже придумывало название само.
 *
 * Раньше это был набор в памяти: он обнулялся при каждом запуске, и
 * приложение при следующем открытии чата снова записывало в заголовок первое
 * сообщение — поверх имени, заданного человеком вручную. Поэтому признак
 * переехал в десктопную базу, которая есть в любом режиме подключения.
 */

const TABLE = "desktop_auto_titled";

function ensureTable(): ReturnType<typeof getDesktopDb> {
  const db = getDesktopDb();
  if (!db) return null;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      session_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL DEFAULT (strftime('%s', 'now'))
    );
  `);
  return db;
}

export function wasAutoTitled(sessionId: string): boolean {
  if (!sessionId) return false;
  const db = ensureTable();
  if (!db) return false;
  const row = db
    .prepare(`SELECT session_id FROM ${TABLE} WHERE session_id = ?`)
    .get(sessionId) as { session_id: string } | undefined;
  return !!row;
}

export function markAutoTitled(sessionId: string): void {
  if (!sessionId) return;
  const db = ensureTable();
  if (!db) return;
  db.prepare(`INSERT OR IGNORE INTO ${TABLE} (session_id) VALUES (?)`).run(
    sessionId,
  );
}
