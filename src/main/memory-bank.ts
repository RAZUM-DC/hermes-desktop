import http from "http";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { app } from "electron";
import { getConnectionConfig } from "./config";
import type { MemoryFact, MemoryPage } from "../shared/memory-bank";

export type { MemoryFact, MemoryPage };

/**
 * Личный банк памяти — то, что ассистент помнит о человеке между разговорами.
 *
 * Путь до него уже построен целиком, просто приложение им не пользовалось:
 *
 *   десктоп → mem-shim (127.0.0.1, порт из status.json)
 *           → agent.razum.tools/mem/…
 *           → identity-proxy (проверяет memory-JWT, форсит личность)
 *           → memory-proxy (решает, читать или писать)
 *           → Hindsight
 *
 * Аутентификация наша — тот же ShimToken, которым приложение ходит в
 * agent-shim: mem-shim сам подменяет его на свежий memory-JWT. Проверено, что
 * `remoteApiKey` в desktop.json и файл `shim-token` у companion — один и тот
 * же ключ.
 *
 * Что сервер разрешает, а что нет (это его решение, не наше):
 *   чтение   — GET …/memories/list
 *   запись   — ЗАПРЕЩЕНА флагом MEMORY_ALLOW_RETAIN=false. Выключена
 *              осознанно после разбора безопасности (red-team P6): защита от
 *              того, чтобы агент дописывал себе долговременную память по ходу
 *              разговора. Флаг действует на весь сервис и всех пользователей.
 *   удаление — ЗАПРЕЩЕНО: identity-proxy режет по самому пути слова
 *              reflect/delete/archive, не по правам.
 *
 * Поэтому здесь только чтение. Писать функцию, которая заведомо вернёт 403,
 * значит оставить ловушку следующему, кто её увидит и решит, что она рабочая.
 */

interface CompanionStatus {
  bankId: string;
  memPort: number;
  ready: boolean;
}

function companionDataDir(): string {
  const local = process.env.LOCALAPPDATA;
  if (local) return join(local, "HermesCompanion");
  return join(app.getPath("home"), ".hermes-companion");
}

/**
 * Читает status.json companion. Оттуда берётся и порт mem-shim, и
 * идентификатор банка — сам десктоп их не знает и знать не может: банк
 * заводится на сервере при первом входе.
 */
export function readCompanionStatus(): CompanionStatus | null {
  try {
    const p = join(companionDataDir(), "status.json");
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf-8").replace(/^\uFEFF/, ""));
    const bankId = typeof raw.bank_id === "string" ? raw.bank_id : "";
    const memPort = Number(raw.mem_port) || 0;
    if (!bankId || !memPort) return null;
    return {
      bankId,
      memPort,
      ready: raw.ready === true || raw.state === "ready",
    };
  } catch {
    return null;
  }
}

/** Строка даты из Hindsight → мс от эпохи. 0, если даты нет или она битая. */
export function parseFactTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Hindsight отдаёт секунды, а не миллисекунды.
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value.trim()) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Приводит запись Hindsight к тому, что нужно экрану.
 *
 * Полей у записи двадцать, экрану нужны пять. Разбор вынесен отдельно и
 * покрыт тестами, потому что форма ответа — чужая и меняется не по нашей
 * воле: пропавшее поле не должно ронять весь список.
 */
export function normalizeFact(row: unknown): MemoryFact | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const text = typeof r.text === "string" ? r.text.trim() : "";
  if (!text) return null;
  return {
    id: typeof r.id === "string" ? r.id : "",
    text,
    factType: typeof r.fact_type === "string" ? r.fact_type : "",
    tags: Array.isArray(r.tags)
      ? r.tags.filter((t): t is string => typeof t === "string")
      : [],
    state: typeof r.state === "string" ? r.state : "",
    at: parseFactTime(r.mentioned_at ?? r.date ?? r.occurred_start),
  };
}

/** Ответ Hindsight → страница фактов. Мусор молча отбрасывается. */
export function normalizePage(payload: unknown): MemoryPage {
  const p = (payload ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(p.items) ? p.items : [];
  const items = rows
    .map(normalizeFact)
    .filter((f): f is MemoryFact => f !== null);
  const total = Number(p.total);
  return { items, total: Number.isFinite(total) ? total : items.length };
}

/**
 * Человеческое объяснение отказа.
 *
 * 403 здесь значит не «что-то сломалось», а «сервер это запрещает», и
 * человеку надо сказать именно это — иначе он будет жать кнопку снова.
 */
export function describeMemoryError(status: number, body: string): string {
  if (status === 403) {
    return "forbidden";
  }
  if (status === 401) return "unauthorized";
  if (status === 503 || status === 502 || status === 504) return "unavailable";
  return body.slice(0, 200) || `HTTP ${status}`;
}

function request(
  status: CompanionStatus,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<unknown> {
  const token = getConnectionConfig().apiKey.trim();
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: status.memPort,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          // Оба заголовка — как и в agent-shim: шим принимает любой из них и
          // всё равно подменит Authorization на свежий memory-JWT.
          Authorization: `Bearer ${token}`,
          "X-Shim-Token": token,
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("error", reject);
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          const code = res.statusCode ?? 500;
          if (code >= 400) {
            reject(new Error(describeMemoryError(code, text)));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch {
            reject(new Error("bad-json"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("unavailable")));
    req.on("error", () => reject(new Error("unavailable")));
    if (payload) req.write(payload);
    req.end();
  });
}

function bankPath(status: CompanionStatus, tail: string): string {
  // bank_id в URL сервер всё равно заменит на форснутый из JWT — подставляем
  // свой только чтобы путь был корректным.
  return `/mem/v1/default/banks/${encodeURIComponent(status.bankId)}/memories${tail}`;
}

export async function listMemoryFacts(
  limit = 50,
  offset = 0,
): Promise<MemoryPage> {
  const status = readCompanionStatus();
  if (!status) throw new Error("unavailable");
  const payload = await request(
    status,
    bankPath(status, `/list?limit=${limit}&offset=${offset}`),
    "GET",
  );
  return normalizePage(payload);
}
