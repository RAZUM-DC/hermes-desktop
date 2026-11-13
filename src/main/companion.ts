import { spawn, ChildProcess } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { app, BrowserWindow, shell } from "electron";
import { HERMES_HOME } from "./installer";

// Hermes Companion — локальный сопроцесс (config_owner): enroll, LLM/mem-шимы и
// супервизия tool-connector'а (локальные инструменты fs/shell на машине
// пользователя). Бинарь бандлится в resources/bin (electron-builder
// extraResources). Здесь только запуск/останов; вся логика — в Go-бинаре.

const IS_WINDOWS = process.platform === "win32";
let proc: ChildProcess | null = null;
// Перезапуск companion, если он упал во время работы приложения (BUG-086).
// Не перезапускаем после штатной остановки (stopCompanion) и после выхода с
// кодом 0 — так companion завершается, когда уже работает другой экземпляр.
let stopping = false;
let restartTimer: NodeJS.Timeout | null = null;
let recentCrashes: number[] = [];
export const COMPANION_RESTART_DELAYS_MS = [
  2_000, 5_000, 15_000, 30_000, 60_000,
];
const CRASH_WINDOW_MS = 10 * 60_000;

/** Задержка перед перезапуском после аварийного выхода, или null — не
 *  перезапускать (штатный выход либо слишком много падений подряд). */
export function companionRestartDelay(
  code: number | null,
  crashesInWindow: number,
): number | null {
  if (code === 0) return null;
  if (crashesInWindow > COMPANION_RESTART_DELAYS_MS.length) return null;
  return COMPANION_RESTART_DELAYS_MS[
    Math.min(crashesInWindow, COMPANION_RESTART_DELAYS_MS.length) - 1
  ];
}

// ── Яндекс OAuth (системный браузер) ─────────────────────────────────────────
// Companion в режиме enroll пишет authURL в status.json (поле auth_url,
// state="enrolling"). Открываем его в СИСТЕМНОМ браузере (shell.openExternal):
// встроенное окно Electron не годится — passport.yandex ломает вёрстку/JS в
// webview и не реагирует на клики. Companion ловит code на loopback
// (127.0.0.1:18656) и доводит enroll; наш поллер увидит state="ready".
let pollTimer: NodeJS.Timeout | null = null;
let lastAuthUrl: string | null = null;

interface CompanionStatus {
  state?: string;
  ready?: boolean;
  auth_url?: string;
}

// dataDir companion: %LOCALAPPDATA%\HermesCompanion (Windows) либо
// ~/.hermes-companion (прочие). Совпадает с dataDir() в Go-companion.
function companionDataDir(): string {
  const local = process.env.LOCALAPPDATA;
  if (local) return join(local, "HermesCompanion");
  return join(app.getPath("home"), ".hermes-companion");
}

function statusPath(): string {
  return join(companionDataDir(), "status.json");
}

function readStatus(): CompanionStatus | null {
  try {
    const p = statusPath();
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as CompanionStatus;
  } catch {
    return null;
  }
}

function openAuthExternal(url: string): void {
  // Системный браузер — Яндекс OAuth не работает во встроенном окне Electron.
  void shell.openExternal(url);
  console.log("[companion] opened Яндекс OAuth in system browser");
}

function pollStatus(): void {
  const st = readStatus();
  if (!st) return;
  if (st.state === "ready" || st.ready === true) {
    lastAuthUrl = null;
    return;
  }
  if (st.state === "enrolling" && st.auth_url) {
    if (st.auth_url !== lastAuthUrl) {
      lastAuthUrl = st.auth_url;
      openAuthExternal(st.auth_url);
    }
  }
}

function startStatusPoller(): void {
  if (pollTimer) return;
  lastAuthUrl = null;
  pollTimer = setInterval(pollStatus, 1500);
}

function stopStatusPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  lastAuthUrl = null;
}

function companionBinary(): string | null {
  const name = IS_WINDOWS ? "companion.exe" : "companion";
  const candidates = [
    join(process.resourcesPath || "", "bin", name),
    join(app.getAppPath(), "..", "bin", name),
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

export function startCompanion(
  _getMainWindow?: () => BrowserWindow | null,
): void {
  if (proc) return;
  stopping = false;
  if (process.env.HERMES_DISABLE_COMPANION === "1") return;
  const bin = companionBinary();
  if (!bin) {
    console.warn(
      "[companion] binary not found in resources/bin — local tools disabled",
    );
    return;
  }
  try {
    proc = spawn(bin, ["run"], {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // КРИТИЧНО: companion пишет desktop.json в ТОТ ЖЕ HERMES_HOME, что
      // читает приложение (иначе remote-конфиг не виден -> остаётся Welcome).
      env: { ...process.env, HERMES_HOME },
    });
    proc.stdout?.on("data", (d) =>
      console.log("[companion]", String(d).trimEnd()),
    );
    proc.stderr?.on("data", (d) =>
      console.log("[companion]", String(d).trimEnd()),
    );
    proc.on("exit", (code, signal) => {
      console.log("[companion] exited", code, signal ?? "");
      proc = null;
      if (stopping) return;
      const now = Date.now();
      recentCrashes = recentCrashes.filter((t) => now - t < CRASH_WINDOW_MS);
      if (code !== 0) recentCrashes.push(now);
      const delay = companionRestartDelay(code, recentCrashes.length);
      if (delay === null) {
        if (code !== 0) {
          console.error(
            "[companion] падает слишком часто — перезапуск остановлен",
          );
        }
        return;
      }
      console.warn(
        `[companion] аварийный выход — перезапуск через ${delay} мс`,
      );
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!stopping) startCompanion(_getMainWindow);
      }, delay);
    });
    console.log("[companion] started:", bin);
    // Поллер status.json: открывает OAuth в системном браузере при enrolling.
    startStatusPoller();
  } catch (e) {
    console.error("[companion] spawn failed:", e);
    proc = null;
  }
}

// writeReenrollFlag — пишет пустой флаг-файл `reenroll` в каталог данных
// companion (%LOCALAPPDATA%\HermesCompanion). Go-companion поллит этот файл и
// при появлении запускает enroll заново (без рестарта приложения). Затем он
// перезапишет status.json (state=enrolling + auth_url), а наш поллер
// откроет вход через Яндекс ID в системном браузере.
export function writeReenrollFlag(): { ok: boolean; error?: string } {
  try {
    const p = join(companionDataDir(), "reenroll");
    writeFileSync(p, "");
    // На случай, если поллер был остановлен — гарантируем, что он работает.
    startStatusPoller();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function stopCompanion(): void {
  stopping = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  stopStatusPoller();
  if (!proc) return;
  try {
    proc.kill();
  } catch {
    /* best effort */
  }
  proc = null;
}
