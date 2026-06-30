import { useCallback, useEffect, useState } from "react";
import { X, RefreshCw } from "lucide-react";

// Витрина штатных ИИ-сотрудников: список из GET /agents, доска выбранного агента
// через мостик /agents/<rid>/api/plugins/kanban/*. Позволяет поставить задачу и
// согласовать гейт прямо из десктопа (remote-режим). Типобезопасность IPC —
// через `as any`, чтобы не плодить декларации (методы добавлены в preload).
type Agent = {
  runtime_id: string;
  display_name?: string;
  role?: string;
  subtitle?: string;
};
type Task = {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  latest_summary?: string;
};

const api = () => window.hermesAPI as unknown as {
  listStaffAgents: () => Promise<{ success: boolean; data?: unknown; error?: string }>;
  agentKanbanRequest: (
    rid: string,
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>;
};

export default function StaffPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sel, setSel] = useState<Agent | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const loadAgents = useCallback(async () => {
    setErr("");
    const r = await api().listStaffAgents();
    if (!r.success) {
      setErr(r.error || "Не удалось загрузить агентов");
      return;
    }
    setAgents(((r.data as { agents?: Agent[] })?.agents) || []);
  }, []);

  const loadBoard = useCallback(async (rid: string) => {
    setErr("");
    const r = await api().agentKanbanRequest(rid, "GET", "/api/plugins/kanban/board");
    if (!r.success) {
      setErr(r.error || "Не удалось загрузить доску");
      return;
    }
    const cols = ((r.data as { columns?: { tasks?: Task[] }[] })?.columns) || [];
    setTasks(cols.flatMap((c) => c.tasks || []));
  }, []);

  useEffect(() => {
    if (open) void loadAgents();
  }, [open, loadAgents]);

  useEffect(() => {
    if (sel) void loadBoard(sel.runtime_id);
  }, [sel, loadBoard]);

  const createTask = useCallback(async () => {
    if (!sel || !title.trim()) return;
    setBusy(true);
    const r = await api().agentKanbanRequest(
      sel.runtime_id,
      "POST",
      "/api/plugins/kanban/tasks",
      { title: title.trim(), body: body.trim(), assignee: "default" },
    );
    setBusy(false);
    if (!r.success) {
      setErr(r.error || "Не удалось создать задачу");
      return;
    }
    setTitle("");
    setBody("");
    void loadBoard(sel.runtime_id);
  }, [sel, title, body, loadBoard]);

  const decide = useCallback(
    async (taskId: string, verdict: "approve" | "changes" | "reject") => {
      if (!sel) return;
      setBusy(true);
      const labels: Record<string, string> = {
        approve: "✅ Утверждено",
        changes: "🔄 Требуются правки",
        reject: "❌ Отклонено",
      };
      await api().agentKanbanRequest(
        sel.runtime_id,
        "POST",
        `/api/plugins/kanban/tasks/${taskId}/comments`,
        { body: labels[verdict] },
      );
      if (verdict !== "reject") {
        await api().agentKanbanRequest(
          sel.runtime_id,
          "PATCH",
          `/api/plugins/kanban/tasks/${taskId}`,
          { status: "ready" },
        );
      }
      setBusy(false);
      void loadBoard(sel.runtime_id);
    },
    [sel, loadBoard],
  );

  if (!open) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        zIndex: 50,
        padding: "40px 16px",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 680,
          maxWidth: "100%",
          maxHeight: "85vh",
          overflow: "auto",
          background: "var(--card, #14181f)",
          color: "var(--text, #e6e6e6)",
          borderRadius: 12,
          padding: 20,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <strong style={{ fontSize: 16 }}>Штатные ИИ-сотрудники</strong>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => (sel ? loadBoard(sel.runtime_id) : loadAgents())}>
              <RefreshCw size={14} />
            </button>
            <button className="btn btn-secondary" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        </div>

        {err && <div style={{ color: "#ff6b6b", marginBottom: 10 }}>{err}</div>}

        {!sel && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {agents.length === 0 && <div style={{ opacity: 0.6 }}>Список пуст (нужен remote-режим).</div>}
            {agents.map((a) => (
              <button
                key={a.runtime_id}
                className="btn btn-secondary"
                style={{ textAlign: "left", padding: "10px 12px" }}
                onClick={() => setSel(a)}
              >
                <div style={{ fontWeight: 600 }}>{a.display_name || a.runtime_id}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{a.role || a.subtitle || ""}</div>
              </button>
            ))}
          </div>
        )}

        {sel && (
          <div>
            <button className="btn btn-secondary" style={{ marginBottom: 12 }} onClick={() => setSel(null)}>
              ← К списку
            </button>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{sel.display_name} — поставить задачу</div>
            <input
              style={{ width: "100%", marginBottom: 6, padding: 8 }}
              placeholder="Заголовок задачи"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              style={{ width: "100%", marginBottom: 6, padding: 8 }}
              placeholder="Что нужно сделать (бриф)"
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <button className="btn btn-primary" disabled={busy || !title.trim()} onClick={createTask}>
              Поставить задачу
            </button>

            <div style={{ fontWeight: 600, margin: "16px 0 8px" }}>Задачи</div>
            {tasks.length === 0 && <div style={{ opacity: 0.6 }}>Задач пока нет.</div>}
            {tasks.map((tk) => (
              <div key={tk.id} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: 10, marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontWeight: 600 }}>{tk.title}</span>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>{tk.status}</span>
                </div>
                {tk.latest_summary && (
                  <div style={{ fontSize: 13, opacity: 0.85, marginTop: 6, whiteSpace: "pre-wrap" }}>{tk.latest_summary}</div>
                )}
                {tk.status === "blocked" && (
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    <button className="btn btn-primary" disabled={busy} onClick={() => decide(tk.id, "approve")}>Утвердить</button>
                    <button className="btn btn-secondary" disabled={busy} onClick={() => decide(tk.id, "changes")}>Правки</button>
                    <button className="btn btn-danger" disabled={busy} onClick={() => decide(tk.id, "reject")}>Отклонить</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
