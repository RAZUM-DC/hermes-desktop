import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Refresh, Spinner } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";

/**
 * Штатные ИИ-сотрудники.
 *
 * Раньше это жило окошком поверх трёхмерного «Офиса» — по кнопке «Штат».
 * Сам «Офис» в гибриде показывал одну выдуманную фигурку (список агентов он
 * читал из локальных файлов, которых здесь нет) и ещё расходовал под тридцать
 * мегабайт на сцену, которую нечем было наполнить. Единственное, что там
 * работало по-настоящему, — вот этот список: он ходит на сервер. Поэтому он и
 * стал отдельным разделом, а комната из сборки ушла.
 *
 * Сотрудник — не профиль из «Профилей». Профиль это локальная папка с
 * настройками, а здесь настоящие агенты на сервере, у каждого своя доска
 * задач, и ходим мы к ним через мостик identity-proxy.
 */

interface StaffAgent {
  runtime_id: string;
  display_name?: string;
  title?: string;
  role?: string;
  subtitle?: string;
  email?: string;
}

interface StaffTask {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  latest_summary?: string;
}

/** Как зовут сотрудника: что сервер дал, то и показываем. */
function agentName(agent: StaffAgent): string {
  return agent.display_name || agent.title || agent.runtime_id;
}

function agentRole(agent: StaffAgent): string {
  return agent.role || agent.subtitle || agent.email || "";
}

interface StaffProps {
  /** Вкладка на экране: по ней решаем, когда грузить и когда опрашивать. */
  visible?: boolean;
}

export function Staff({ visible }: StaffProps): React.JSX.Element {
  const { t } = useI18n();
  const [agents, setAgents] = useState<StaffAgent[]>([]);
  const [selected, setSelected] = useState<StaffAgent | null>(null);
  const [tasks, setTasks] = useState<StaffTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const loadAgents = useCallback(async (): Promise<void> => {
    setError("");
    try {
      const r = await window.hermesAPI.listStaffAgents();
      if (!r.success) {
        setError(r.error || t("staff.loadFailed"));
        return;
      }
      setAgents(r.data?.agents ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("staff.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadBoard = useCallback(
    async (rid: string): Promise<void> => {
      setError("");
      try {
        const r = await window.hermesAPI.agentKanbanRequest(
          rid,
          "GET",
          "/api/plugins/kanban/board",
        );
        if (!r.success) {
          setError(r.error || t("staff.boardFailed"));
          return;
        }
        const columns =
          (r.data as { columns?: { tasks?: StaffTask[] }[] })?.columns ?? [];
        setTasks(columns.flatMap((c) => c.tasks ?? []));
      } catch (e) {
        setError(e instanceof Error ? e.message : t("staff.boardFailed"));
      }
    },
    [t],
  );

  useEffect(() => {
    if (visible) void loadAgents();
  }, [visible, loadAgents]);

  useEffect(() => {
    if (selected) void loadBoard(selected.runtime_id);
  }, [selected, loadBoard]);

  // Доска живая: сотрудник работает сам, и статус задачи меняется без нас.
  // Опрашиваем только пока вкладка открыта — фоновый опрос невидимого экрана
  // грел бы и сеть, и сервер впустую.
  useEffect(() => {
    if (!visible || !selected) return;
    const timer = setInterval(
      () => void loadBoard(selected.runtime_id),
      10_000,
    );
    return () => clearInterval(timer);
  }, [visible, selected, loadBoard]);

  const createTask = useCallback(async (): Promise<void> => {
    if (!selected || !title.trim() || busy) return;
    setBusy(true);
    try {
      const r = await window.hermesAPI.agentKanbanRequest(
        selected.runtime_id,
        "POST",
        "/api/plugins/kanban/tasks",
        {
          title: title.trim(),
          ...(body.trim() ? { body: body.trim() } : {}),
          // Как и на обычной доске в гибриде: агент работает на сервере, и
          // рабочая папка у него может быть только серверная временная.
          // Прежняя панель это поле не слала вовсе — отсюда и 422.
          workspace_kind: "scratch",
        },
      );
      if (!r.success) {
        // Человеческая строка впереди, ответ сервера следом. Одного ответа
        // мало: он приходит как JSON валидатора и ничего не говорит тому, кто
        // просто хотел поставить задачу. Убирать его тоже нельзя — именно по
        // нему видно, что сломалось, и с чем идти к владельцу сервера.
        setError(
          r.error
            ? `${t("staff.createFailed")} ${r.error}`
            : t("staff.createFailed"),
        );
        return;
      }
      setTitle("");
      setBody("");
      await loadBoard(selected.runtime_id);
    } finally {
      setBusy(false);
    }
  }, [selected, title, body, busy, loadBoard, t]);

  /**
   * Решение по задаче, которая встала на согласование.
   *
   * Вердикт уходит комментарием, и только «утверждено» и «правки» снимают
   * блокировку — отклонённая задача остаётся заблокированной нарочно, иначе
   * сотрудник немедленно взял бы её снова.
   */
  const decide = useCallback(
    async (
      taskId: string,
      verdict: "approve" | "changes" | "reject",
    ): Promise<void> => {
      if (!selected || busy) return;
      setBusy(true);
      try {
        await window.hermesAPI.agentKanbanRequest(
          selected.runtime_id,
          "POST",
          `/api/plugins/kanban/tasks/${taskId}/comments`,
          { body: t(`staff.verdict.${verdict}`) },
        );
        if (verdict !== "reject") {
          await window.hermesAPI.agentKanbanRequest(
            selected.runtime_id,
            "PATCH",
            `/api/plugins/kanban/tasks/${taskId}`,
            { status: "ready" },
          );
        }
        await loadBoard(selected.runtime_id);
      } finally {
        setBusy(false);
      }
    },
    [selected, busy, loadBoard, t],
  );

  const refresh = (): void => {
    if (selected) void loadBoard(selected.runtime_id);
    else void loadAgents();
  };

  return (
    <div className="settings-container">
      <div className="memory-header">
        <div>
          <h1 className="settings-header" style={{ marginBottom: 4 }}>
            {selected ? agentName(selected) : t("staff.title")}
          </h1>
          <p className="memory-subtitle">
            {selected ? agentRole(selected) : t("staff.subtitle")}
          </p>
        </div>
        <button
          className="btn btn-secondary btn-sm"
          onClick={refresh}
          title={t("common.refresh")}
        >
          <Refresh size={13} />
        </button>
      </div>

      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}

      {!selected && loading && (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <div className="loading-spinner" />
        </div>
      )}

      {!selected && !loading && agents.length === 0 && !error && (
        <p className="memory-subtitle">{t("staff.empty")}</p>
      )}

      {!selected && agents.length > 0 && (
        <div className="staff-grid">
          {agents.map((a) => (
            <button
              key={a.runtime_id}
              className="staff-card"
              onClick={() => setSelected(a)}
            >
              <span className="staff-card-name">{agentName(a)}</span>
              <span className="staff-card-role">{agentRole(a)}</span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <>
          <div className="staff-bar">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setSelected(null);
                setTasks([]);
              }}
            >
              <ArrowRight size={13} style={{ transform: "rotate(180deg)" }} />
              {t("staff.back")}
            </button>
          </div>

          <div className="settings-field">
            <label className="settings-field-label">{t("staff.newTask")}</label>
            <input
              className="input"
              placeholder={t("staff.taskTitle")}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              className="input"
              style={{ marginTop: 8 }}
              rows={3}
              placeholder={t("staff.taskBody")}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <div className="memory-bank-actions">
              <button
                className="btn btn-primary btn-sm"
                disabled={busy || !title.trim()}
                onClick={() => void createTask()}
              >
                {t("staff.assign")}
                {busy && <Spinner size={13} />}
              </button>
            </div>
          </div>

          <p className="memory-subtitle" style={{ marginTop: 16 }}>
            {t("staff.tasks")}
          </p>
          {tasks.length === 0 ? (
            <p className="memory-subtitle">{t("staff.noTasks")}</p>
          ) : (
            <div className="staff-tasks">
              {tasks.map((task) => (
                <div key={task.id} className="staff-task">
                  <div className="staff-task-head">
                    <span className="staff-task-title">{task.title}</span>
                    <span className="staff-task-status">{task.status}</span>
                  </div>
                  {task.latest_summary && (
                    <div className="staff-task-summary">
                      {task.latest_summary}
                    </div>
                  )}
                  {task.status === "blocked" && (
                    <div className="staff-task-actions">
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={busy}
                        onClick={() => void decide(task.id, "approve")}
                      >
                        {t("staff.approve")}
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={busy}
                        onClick={() => void decide(task.id, "changes")}
                      >
                        {t("staff.changes")}
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        disabled={busy}
                        onClick={() => void decide(task.id, "reject")}
                      >
                        {t("staff.reject")}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default Staff;
