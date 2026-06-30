import { app, BrowserWindow, Notification } from "electron";
import { listStaffAgents, agentKanbanRequest } from "./kanban";
import { isRemoteOnlyMode } from "./hermes";

// Фоновый наблюдатель доски «ИИ-сотрудники». Раз в POLL_MS опрашивает штатных
// агентов (тот же staff-мостик, что и UI) и шлёт нативное уведомление при смене
// статуса карточки: blocked → «ждёт решения», done → «результат готов»,
// failed → «ошибка». Бэйдж/мигание таскбара = число карточек, ждущих человека.
// Работает независимо от того, открыт ли экран Канбана.

const POLL_MS = 20000;
const APP_NAME =
  process.env.HERMES_DESKTOP_APP_NAME?.trim() || "РАЗУМ Ассистент";

type Snapshot = Map<string, string>; // ключ `${rid}:${taskId}` → status

interface StaffAgent {
  runtime_id: string;
  display_name?: string;
  role?: string;
  name?: string;
}
interface StaffTask {
  id: string;
  title?: string;
  status?: string;
}

let timer: ReturnType<typeof setInterval> | null = null;
let prev: Snapshot | null = null; // null = ещё не было первого замера
let getWin: (() => BrowserWindow | null) | null = null;

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const win = getWin?.() || null;
  // Не нагружаем, когда окно в фокусе — пользователь и так смотрит.
  if (win && win.isFocused()) return;
  try {
    new Notification({ title, body }).show();
  } catch {
    /* no-op */
  }
}

function setAttention(badge: number, hasNewBlocked: boolean): void {
  try {
    app.setBadgeCount(badge); // macOS/Linux; на Windows — no-op
  } catch {
    /* no-op */
  }
  const win = getWin?.() || null;
  if (!win) return;
  // Windows: setBadgeCount не рисует число → привлекаем внимание миганием
  // иконки в таскбаре при новой карточке, ждущей решения.
  if (hasNewBlocked && !win.isFocused()) {
    try {
      win.flashFrame(true);
    } catch {
      /* no-op */
    }
  }
}

function label(t: StaffTask, agent: StaffAgent): string {
  const who = agent.display_name || "ИИ-сотрудник";
  const what = (t.title || "задача").slice(0, 60);
  return `${who}: ${what}`;
}

async function tick(): Promise<void> {
  if (!isRemoteOnlyMode()) return;
  const next: Snapshot = new Map();
  let blockedTotal = 0;
  let newBlocked = false;

  const sres = await listStaffAgents();
  if (!sres.success || !sres.data) return;
  const agents =
    ((sres.data as { agents?: StaffAgent[] }).agents || []).filter(
      (a) => a && a.runtime_id,
    );

  for (const agent of agents) {
    const br = await agentKanbanRequest(
      agent.runtime_id,
      "GET",
      "/api/plugins/kanban/board",
    );
    if (!br.success || !br.data) continue;
    const cols =
      ((br.data as { columns?: { tasks?: StaffTask[] }[] }).columns || []);
    const tasks = cols.flatMap((c) => c.tasks || []);
    for (const t of tasks) {
      if (!t || !t.id) continue;
      const key = `${agent.runtime_id}:${t.id}`;
      const status = (t.status || "").toLowerCase();
      next.set(key, status);
      if (status === "blocked") blockedTotal += 1;

      if (prev) {
        const was = prev.get(key);
        if (was !== status) {
          if (status === "blocked") {
            newBlocked = true;
            notify(`${APP_NAME} — ждёт решения`, label(t, agent));
          } else if (status === "done") {
            notify(`${APP_NAME} — результат готов`, label(t, agent));
          } else if (status === "failed" || status === "error") {
            notify(`${APP_NAME} — ошибка`, label(t, agent));
          }
        }
      }
    }
  }

  prev = next;
  setAttention(blockedTotal, newBlocked);
}

export function startStaffWatcher(
  getMainWindow: () => BrowserWindow | null,
): void {
  if (timer) return;
  getWin = getMainWindow;
  // Снимаем мигание, когда пользователь вернулся к окну.
  const win = getMainWindow();
  win?.on("focus", () => {
    try {
      win.flashFrame(false);
    } catch {
      /* no-op */
    }
  });
  // Первый замер — только зафиксировать снимок (без шквала уведомлений).
  void tick();
  timer = setInterval(() => {
    void tick();
  }, POLL_MS);
}

export function stopStaffWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  prev = null;
}
