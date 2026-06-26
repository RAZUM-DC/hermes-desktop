import { useEffect, useRef, useState } from "react";
import {
  Plus,
  Kanban as KanbanIcon,
  Timer,
  Compass,
} from "../../assets/icons";

interface KanbanTaskLite {
  id: string;
  title: string;
  status: string;
}

interface OverviewProps {
  visible?: boolean;
  onNavigate: (view: string) => void;
  onNewChat: () => void;
}

// Status key → human label (RU) + tone class for the badge. Mirrors the
// Kanban screen's column keys so badges read consistently across the app.
const STATUS_LABELS: Record<string, string> = {
  triage: "Триаж",
  todo: "К выполнению",
  scheduled: "Запланирована",
  ready: "Готова к работе",
  running: "В работе",
  blocked: "Заблокирована",
  review: "На проверке",
  done: "Готово",
  archived: "В архиве",
};

const STATUS_TONE: Record<string, string> = {
  triage: "neutral",
  todo: "todo",
  scheduled: "scheduled",
  ready: "ready",
  running: "running",
  blocked: "blocked",
  review: "review",
  done: "done",
  archived: "archived",
};

const CAPABILITIES: { emoji: string; title: string; desc: string }[] = [
  {
    emoji: "📧",
    title: "Почта",
    desc: "Читать, искать, готовить и отправлять письма (Яндекс 360)",
  },
  {
    emoji: "📅",
    title: "Календарь и встречи",
    desc: "События и видеовстречи (Телемост)",
  },
  {
    emoji: "✅",
    title: "Задачи",
    desc: "Поручения в Kaiten и ELMA",
  },
  {
    emoji: "📁",
    title: "Файлы на ПК",
    desc: "Читать и создавать в «Документах» и «Загрузках»",
  },
  {
    emoji: "👥",
    title: "Сотрудники",
    desc: "Оргструктура и контакты",
  },
  {
    emoji: "📚",
    title: "База знаний",
    desc: "Корпоративная вики",
  },
  {
    emoji: "🖼",
    title: "Фотобанк",
    desc: "Изображения проектов РАЗУМ",
  },
  {
    emoji: "🔎",
    title: "Веб-поиск",
    desc: "Актуальная информация из интернета",
  },
];

function Overview({
  visible,
  onNavigate,
  onNewChat,
}: OverviewProps): React.JSX.Element {
  const [tasks, setTasks] = useState<KanbanTaskLite[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  // Load the latest tasks once, on first time the tab becomes visible.
  const loadedRef = useRef(false);

  useEffect(() => {
    if (visible === false) return;
    if (loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;
    window.hermesAPI
      .kanbanListTasks({})
      .then((res) => {
        if (cancelled) return;
        if (res?.success && Array.isArray(res.data)) {
          setTasks(res.data as KanbanTaskLite[]);
        } else {
          setTasks([]);
        }
      })
      .catch(() => {
        if (!cancelled) setTasks([]);
      })
      .finally(() => {
        if (!cancelled) setTasksLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const recentTasks = tasks.slice(0, 5);

  return (
    <div className="overview">
      <div className="overview-inner">
        <header className="overview-hero">
          <h1 className="overview-hero-title">Здравствуйте!</h1>
          <p className="overview-hero-subtitle">
            РАЗУМ Ассистент готов помочь — спросите о почте, календаре, задачах,
            документах или базе знаний, либо начните с быстрых действий ниже.
          </p>
        </header>

        <section className="overview-section">
          <h2 className="overview-section-title">Быстрые действия</h2>
          <div className="overview-actions">
            <button
              type="button"
              className="overview-action"
              onClick={onNewChat}
            >
              <Plus size={18} className="overview-action-icon" />
              <span className="overview-action-label">Новый чат</span>
            </button>
            <button
              type="button"
              className="overview-action"
              onClick={() => onNavigate("kanban")}
            >
              <KanbanIcon size={18} className="overview-action-icon" />
              <span className="overview-action-label">Канбан</span>
            </button>
            <button
              type="button"
              className="overview-action"
              onClick={() => onNavigate("schedules")}
            >
              <Timer size={18} className="overview-action-icon" />
              <span className="overview-action-label">Расписания</span>
            </button>
            <button
              type="button"
              className="overview-action"
              onClick={() => onNavigate("skills")}
            >
              <Compass size={18} className="overview-action-icon" />
              <span className="overview-action-label">Скиллы</span>
            </button>
          </div>
        </section>

        <section className="overview-section">
          <h2 className="overview-section-title">Что умеет ассистент</h2>
          <div className="overview-grid">
            {CAPABILITIES.map((cap) => (
              <div key={cap.title} className="overview-card">
                <span className="overview-card-emoji" aria-hidden="true">
                  {cap.emoji}
                </span>
                <div className="overview-card-body">
                  <div className="overview-card-title">{cap.title}</div>
                  <div className="overview-card-desc">{cap.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="overview-section">
          <h2 className="overview-section-title">Последние задачи</h2>
          {recentTasks.length > 0 ? (
            <div className="overview-tasks">
              {recentTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className="overview-task"
                  onClick={() => onNavigate("kanban")}
                  title={task.title}
                >
                  <span className="overview-task-title">{task.title}</span>
                  <span
                    className="overview-badge"
                    data-tone={STATUS_TONE[task.status] ?? "neutral"}
                  >
                    {STATUS_LABELS[task.status] ?? task.status}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="overview-empty">
              <p className="overview-empty-text">
                {tasksLoaded ? "Задач пока нет" : "Загрузка задач…"}
              </p>
              <button
                type="button"
                className="overview-action overview-empty-action"
                onClick={() => onNavigate("kanban")}
              >
                <KanbanIcon size={16} className="overview-action-icon" />
                <span className="overview-action-label">Открыть Канбан</span>
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default Overview;
