import { spawn, ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { app, BrowserWindow } from "electron";
import { HERMES_HOME } from "./installer";

// Hermes Companion — локальный сопроцесс (config_owner): enroll, LLM/mem-шимы и
// супервизия tool-connector'а (локальные инструменты fs/shell на машине
// пользователя). Бинарь бандлится в resources/bin (electron-builder
// extraResources). Здесь только запуск/останов; вся логика — в Go-бинаре.

const IS_WINDOWS = process.platform === "win32";
let proc: ChildProcess | null = null;

// ── In-app Яндекс OAuth ──────────────────────────────────────────────────────
// Companion в режиме enroll НЕ открывает системный браузер, а пишет authURL в
// status.json (поле auth_url, state="enrolling"). Здесь мы поллим status.json и
// открываем OAuth-окно ВНУТРИ приложения (отдельный BrowserWindow). Когда
// companion ловит code на loopback (127.0.0.1:18656) или статус становится
// "ready" — окно закрывается.
const COMPANION_LOOPBACK = "http://127.0.0.1:18656";
let authWin: BrowserWindow | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let lastAuthUrl: string | null = null;
let getMainWin: (() => BrowserWindow | null) | null = null;

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

function closeAuthWin(): void {
  if (authWin && !authWin.isDestroyed()) {
    try {
      authWin.close();
    } catch {
      /* best effort */
    }
  }
  authWin = null;
}

function maybeCloseOnLoopback(u: string): void {
  if (u.startsWith(COMPANION_LOOPBACK)) {
    // companion поймал code и отдал страницу «Готово» — даём прочитать ~1с.
    setTimeout(() => {
      if (authWin && !authWin.isDestroyed()) authWin.close();
    }, 1000);
  }
}

function openAuthWindow(url: string): void {
  if (authWin && !authWin.isDestroyed()) return; // уже открыто
  const parent = getMainWin?.() || undefined;
  authWin = new BrowserWindow({
    width: 520,
    height: 720,
    title: "Вход через Яндекс ID",
    autoHideMenuBar: true,
    parent: parent || undefined,
    modal: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  // НЕ навешиваем рестриктивный will-navigate: окну разрешена навигация между
  // доменами Яндекса (oauth.yandex.ru ↔ passport.yandex.ru ↔ ya.ru) и переход
  // на loopback companion (127.0.0.1:18656). Безопасность mainWindow/webview не
  // ослабляется — это изолированное OAuth-окно.
  authWin.webContents.on("will-redirect", (_e, u) => maybeCloseOnLoopback(u));
  authWin.webContents.on("did-navigate", (_e, u) => maybeCloseOnLoopback(u));
  authWin.on("closed", () => {
    authWin = null;
  });
  authWin.loadURL(url);
  console.log("[companion] opened in-app Яндекс OAuth window");
}

function pollStatus(): void {
  const st = readStatus();
  if (!st) return;
  if (st.state === "ready" || st.ready === true) {
    // Вход завершён — закрыть окно, если ещё открыто.
    closeAuthWin();
    return;
  }
  if (st.state === "enrolling" && st.auth_url) {
    if (st.auth_url !== lastAuthUrl || !authWin) {
      lastAuthUrl = st.auth_url;
      openAuthWindow(st.auth_url);
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
  closeAuthWin();
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
  getMainWindow?: () => BrowserWindow | null,
): void {
  if (getMainWindow) getMainWin = getMainWindow;
  if (proc) return;
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
    proc.on("exit", (code) => {
      console.log("[companion] exited", code);
      proc = null;
    });
    console.log("[companion] started:", bin);
    // Поллер status.json: открывает in-app OAuth-окно при state=enrolling.
    startStatusPoller();
  } catch (e) {
    console.error("[companion] spawn failed:", e);
    proc = null;
  }
}

export function stopCompanion(): void {
  stopStatusPoller();
  if (!proc) return;
  try {
    proc.kill();
  } catch {
    /* best effort */
  }
  proc = null;
}
