import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Chat from "../Chat/Chat";
import {
  dbItemsToChatMessages,
  type DbHistoryItem,
} from "../Chat/sessionHistory";
import {
  shouldPersistAutoTitle,
  type ChatRun,
  mintRun,
  patchRun,
  isScratchRun,
  openSessionRunTransition,
  selectProfileRunTransition,
  findRunBySession,
  loadingSessionIds as deriveLoadingSessionIds,
} from "./chatRuns";
import { ActiveSessionsBar } from "./ActiveSessionsBar";
import Sessions from "../Sessions/Sessions";
import Agents from "../Agents/Agents";
import Discover from "../Discover/Discover";
import Overview from "../Discover/Overview";
import ProfileSwitcher from "./ProfileSwitcher";
import SidebarRecentSessions from "./SidebarRecentSessions";
import {
  advance,
  neighbourRunId,
  openSwitcher,
  runIdAtPosition,
  SWITCHER_LIMIT,
  type SwitcherItem,
  type SwitcherState,
} from "./runSwitcher";
import { ChatSwitcherOverlay } from "./ChatSwitcherOverlay";
import { DraftTray } from "./DraftTray";
import {
  clearDrafts,
  isInsertable,
  isRecognizing,
  markInserting,
  pushDraft,
  removeDraft,
  resolveTextDraft,
  type PendingDraft,
} from "./draftStack";
import {
  acceleratorModifiers,
  formatAccelerator,
  INSERT_DRAFT_DEFAULT,
  matchesAccelerator,
  NEXT_CHAT_DEFAULT,
  PREV_CHAT_DEFAULT,
  SWITCH_CHAT_DEFAULT,
} from "../../../../shared/hotkeys";
import Skills from "../Skills/Skills";
import Memory from "../Memory/Memory";
import { MemoryBank } from "../Memory/MemoryBank";
import Notes from "../Notes/Notes";
import Tools from "../Tools/Tools";
import Gateway from "../Gateway/Gateway";
import Staff from "../Staff/Staff";
import Providers from "../Providers/Providers";
import Schedules from "../Schedules/Schedules";
import Kanban from "../Kanban/Kanban";
import RemoteNotice from "../../components/RemoteNotice";
import VerifyWarningBanner from "../../components/VerifyWarningBanner";
import { useSettingsModal } from "../../components/settings/SettingsModalContext";
import SidebarBrand from "../../components/common/SidebarBrand";
import {
  Compass,
  Settings as SettingsIcon,
  Brain,
  Workflow,
  Users as StaffIcon,
  Timer,
  Kanban as KanbanIcon,
  NotesIcon,
  Download,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Users,
  Puzzle,
  Plug,
  Signal,
} from "../../assets/icons";
import type { LucideIcon } from "lucide-react";
import { useI18n } from "../../components/useI18n";
import type { AttachmentError } from "../Chat/attachmentUtils";

type View =
  | "chat"
  | "discover"
  | "agents"
  | "staff"
  | "providers"
  | "skills"
  | "memory"
  | "notes"
  | "tools"
  | "schedules"
  | "kanban"
  | "gateway";

const PINNED_NAV_ITEMS: { view: View; icon: LucideIcon; labelKey: string }[] = [
  { view: "discover", icon: Compass, labelKey: "navigation.discover" },
  // "agents" (Profiles) is reached from the sidebar-footer ProfileSwitcher's
  // "Manage profiles" action rather than a top-level nav item.
  // «Офис» убран: трёхмерная комната показывала одну выдуманную фигурку —
  // список агентов она читала из локальных файлов, которых в гибриде нет, — а
  // кнопка чата в ней была намертво привязана к локально запущенному шлюзу.
  // Работала там ровно одна вещь, список штатных сотрудников с сервера, и
  // теперь это самостоятельный раздел. Сам экран остался в коде: он рабочий
  // для local и приходит из апстрима, с которым мы продолжаем сливаться.
  { view: "staff", icon: StaffIcon, labelKey: "navigation.staff" },
  { view: "kanban", icon: KanbanIcon, labelKey: "navigation.kanban" },
  // "skills" lives under the Discover tab (installed + community), so it's no
  // longer a top-level nav item.
  { view: "schedules", icon: Timer, labelKey: "navigation.schedules" },
  // Блокнот человека, а не банк памяти: память ведёт ассистент и трогать её
  // руками нельзя, а сюда пишут сами, и лежит это на своей же машине.
  { view: "notes", icon: NotesIcon, labelKey: "navigation.notes" },
];

// Провайдеры и Шлюз из меню убраны намеренно.
//
// Оба экрана читают данные ЛОКАЛЬНОЙ установки: ключи провайдеров из
// ~/.hermes/.env, статус локального шлюза сообщений. В гибриде ничего этого
// нет — ключи на каждого пользователя выдаёт key-broker, модели настраивает
// провижнер, а Telegram подключается через корпоративный онбординг. Экраны
// показывали заглушку «недоступно в удалённом режиме», и человек натыкался на
// неё снова и снова, прежде чем понять, что половина меню бесполезна.
//
// Единственное, что в провайдерах было по-настоящему пользовательским —
// выбор модели, — и он давно живёт прямо в поле ввода.
//
// Сами экраны в коде остались: они рабочие для local и ssh и приходят из
// апстрима, с которым мы продолжаем сливаться.
const FOOTER_NAV_ITEMS: { view: View; icon: LucideIcon; labelKey: string }[] = [
  { view: "tools", icon: Workflow, labelKey: "navigation.tools" },
  { view: "memory", icon: Brain, labelKey: "navigation.memory" },
];

/**
 * Подписи и значки для вкладок разделов в верхней полосе.
 *
 * Собирается из тех же списков, что и боковая панель, чтобы названия не
 * разъехались, и дополняется разделами, которых в меню нет: в них попадают
 * из других мест — «Профили» из переключателя внизу, «Навыки» из «Обзора», —
 * но вкладка нужна им такая же.
 */
const VIEW_TABS: Partial<Record<View, { icon: LucideIcon; labelKey: string }>> =
  {
    ...Object.fromEntries(
      [...PINNED_NAV_ITEMS, ...FOOTER_NAV_ITEMS].map((item) => [
        item.view,
        { icon: item.icon, labelKey: item.labelKey },
      ]),
    ),
    agents: { icon: Users, labelKey: "navigation.agents" },
    skills: { icon: Puzzle, labelKey: "navigation.skills" },
    providers: { icon: Plug, labelKey: "navigation.providers" },
    gateway: { icon: Signal, labelKey: "navigation.gateway" },
  };

const SIDEBAR_COLLAPSED_KEY = "hermes.sidebar.collapsed";
const SIDEBAR_SCROLLBAR_HIDE_MS = 700;

interface LayoutProps {
  verifyWarning?: boolean;
  onReinstall?: () => void;
  onDismissVerifyWarning?: () => void;
}

function Layout({
  verifyWarning,
  onReinstall,
  onDismissVerifyWarning,
}: LayoutProps = {}): React.JSX.Element {
  const { t } = useI18n();
  const { openSettings } = useSettingsModal();
  const [view, setView] = useState<View>("chat");
  // Multiple conversations coexist (background sessions + multi-agent). Each is
  // a ChatRun; all are mounted, only the active one is shown. Profile switches
  // preserve existing conversations and activate a scratch run for the selected
  // agent so `activeProfile` stays aligned with the visible chat transport.
  const [activeProfile, setActiveProfile] = useState("default");
  const [runs, setRuns] = useState<ChatRun[]>(() => [mintRun("default")]);
  const [activeRunId, setActiveRunId] = useState<string>(() => runs[0].runId);
  // While a resume's history is loading, show its spinner immediately.
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(
    null,
  );
  // Sessions whose resume is in flight — dedupes rapid double-clicks that would
  // otherwise mount two tabs for the same session (the live check straddles an
  // await, so it can't rely on `runs` state alone).
  const resumingRef = useRef<Set<string>>(new Set());
  const sidebarChatScrollRef = useRef<HTMLDivElement | null>(null);
  const sidebarScrollbarHideRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [sidebarScrollbar, setSidebarScrollbar] = useState({
    visible: false,
    scrollable: false,
    top: 0,
    height: 0,
  });

  const currentSessionId =
    runs.find((r) => r.runId === activeRunId)?.sessionId ?? null;

  const loadingSessionIds = useMemo(
    () => deriveLoadingSessionIds(runs),
    [runs],
  );

  const updateSidebarScrollbar = useCallback((visible: boolean) => {
    const root = sidebarChatScrollRef.current;
    if (!root) {
      setSidebarScrollbar((prev) =>
        prev.scrollable || prev.visible
          ? { visible: false, scrollable: false, top: 0, height: 0 }
          : prev,
      );
      return;
    }

    const scrollable = root.scrollHeight > root.clientHeight + 1;
    if (!scrollable) {
      setSidebarScrollbar((prev) =>
        prev.scrollable || prev.visible
          ? { visible: false, scrollable: false, top: 0, height: 0 }
          : prev,
      );
      return;
    }

    const trackHeight = root.clientHeight;
    const thumbHeight = Math.max(
      32,
      Math.round((root.clientHeight / root.scrollHeight) * trackHeight),
    );
    const maxTop = Math.max(0, trackHeight - thumbHeight);
    const maxScroll = Math.max(1, root.scrollHeight - root.clientHeight);
    const top = Math.round((root.scrollTop / maxScroll) * maxTop);

    setSidebarScrollbar((prev) => {
      const next = { visible, scrollable, top, height: thumbHeight };
      return prev.visible === next.visible &&
        prev.scrollable === next.scrollable &&
        prev.top === next.top &&
        prev.height === next.height
        ? prev
        : next;
    });
  }, []);

  useEffect(() => {
    const root = sidebarChatScrollRef.current;
    if (!root) return;

    const showThenHide = (): void => {
      updateSidebarScrollbar(true);
      if (sidebarScrollbarHideRef.current) {
        clearTimeout(sidebarScrollbarHideRef.current);
      }
      sidebarScrollbarHideRef.current = setTimeout(() => {
        updateSidebarScrollbar(false);
      }, SIDEBAR_SCROLLBAR_HIDE_MS);
    };

    const updateHidden = (): void => updateSidebarScrollbar(false);
    root.addEventListener("scroll", showThenHide, { passive: true });
    window.addEventListener("resize", updateHidden);
    const observer = new ResizeObserver(updateHidden);
    observer.observe(root);

    updateHidden();
    return () => {
      root.removeEventListener("scroll", showThenHide);
      window.removeEventListener("resize", updateHidden);
      observer.disconnect();
      if (sidebarScrollbarHideRef.current) {
        clearTimeout(sidebarScrollbarHideRef.current);
      }
    };
  }, [updateSidebarScrollbar]);

  // Per-profile avatar/colour, so the active-sessions bar (which only knows a
  // run's profile name) can render real avatars. Refreshed when the selected
  // profile or the current view changes — e.g. after editing on the Agents page.
  const [profileAppearance, setProfileAppearance] = useState<
    Record<string, { color?: string | null; avatar?: string | null }>
  >({});
  useEffect(() => {
    let cancelled = false;
    window.hermesAPI
      .listProfiles()
      .then((list) => {
        if (cancelled) return;
        const map: Record<string, { color?: string; avatar?: string | null }> =
          {};
        for (const p of list)
          map[p.name] = { color: p.color, avatar: p.avatar };
        setProfileAppearance(map);
      })
      .catch(() => {
        /* keep last-known appearance */
      });
    return () => {
      cancelled = true;
    };
  }, [activeProfile, view]);
  const getAppearance = useCallback(
    (profile: string) => profileAppearance[profile] ?? {},
    [profileAppearance],
  );

  // Per-run reporters wired into each <Chat>.
  const handleRunLoading = useCallback((runId: string, loading: boolean) => {
    setRuns((prev) => patchRun(prev, runId, { loading }));
  }, []);
  // Сохраняем сгенерированный заголовок сессии на сервер (иначе удалённые
  // сессии остаются без названия), один раз на сессию.
  const titledSessions = useRef<Set<string>>(new Set());
  const persistSessionTitle = useCallback(
    (run: ChatRun | undefined, sessionId: string, title: string) => {
      const t = title.trim();
      if (!sessionId || titledSessions.current.has(sessionId)) return;
      if (!shouldPersistAutoTitle(run, t)) return;
      titledSessions.current.add(sessionId);
      // sessions.title имеет UNIQUE-ограничение: если такое название уже есть,
      // первый PATCH упадёт — повторяем с суффиксом даты/времени для уникальности.
      const stamp = (): string => {
        const d = new Date();
        const p = (n: number): string => String(n).padStart(2, "0");
        return ` · ${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
      };
      // auto = true: главный процесс сам решит, стоит ли трогать заголовок, и
      // запомнит, что этот диалог уже называли — в отличие от множества выше,
      // переживёт перезапуск.
      void window.hermesAPI
        .updateSessionTitle(sessionId, t, undefined, undefined, true)
        .catch(() =>
          window.hermesAPI
            .updateSessionTitle(
              sessionId,
              t + stamp(),
              undefined,
              undefined,
              true,
            )
            .catch(() => {}),
        );
    },
    [],
  );
  const handleRunSessionId = useCallback(
    (runId: string, sessionId: string | null) => {
      setRuns((prev) => {
        const next = patchRun(prev, runId, { sessionId });
        if (sessionId) {
          const run = next.find((r) => r.runId === runId);
          if (run?.title) persistSessionTitle(run, sessionId, run.title);
        }
        return next;
      });
    },
    [persistSessionTitle],
  );
  const handleRunTitle = useCallback(
    (runId: string, title: string) => {
      setRuns((prev) => {
        const next = patchRun(prev, runId, { title });
        const run = next.find((r) => r.runId === runId);
        if (run?.sessionId) persistSessionTitle(run, run.sessionId, title);
        return next;
      });
    },
    [persistSessionTitle],
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  // Full-list sessions modal (opened from the sidebar "Show more" affordance or
  // the Cmd/Ctrl+K menu action). Reuses the Sessions screen inside a modal —
  // there is no longer a top-level Sessions view.
  const [sessionsModalOpen, setSessionsModalOpen] = useState(false);
  // Tabs lazy-mount on first visit, then stay mounted (display:none toggle).
  // Keeps IPC refetch / DOM rebuild off the tab-switch hot path.
  const [visitedViews, setVisitedViews] = useState<Set<View>>(
    () => new Set<View>(["chat"]),
  );
  // Remote-only mode — SSH tunnel has full access; only pure HTTP remote mode restricts screens
  const [remoteMode, setRemoteMode] = useState(false);
  // Set by the Capabilities screen's "Browse" actions to focus a Discover tab
  // (Skills → Community, or MCPs). The nonce re-fires Discover's effect.
  const [discoverFocus, setDiscoverFocus] = useState<{
    kind: "skills" | "mcps";
    nonce: number;
  } | null>(null);

  /**
   * Разделы, открытые в верхней полосе, в порядке открытия.
   *
   * Отдельно от `visitedViews`: тот только помнит, что вкладку уже монтировали,
   * и порядка не хранит, а полосе он нужен — вкладки не должны прыгать местами
   * при каждом возврате.
   */
  const [openSections, setOpenSections] = useState<View[]>([]);

  const sectionTabs = useMemo(
    () =>
      openSections
        .map((v) => {
          const tab = VIEW_TABS[v];
          return tab ? { view: v, ...tab } : null;
        })
        .filter((t): t is { view: View; icon: LucideIcon; labelKey: string } =>
          Boolean(t),
        ),
    [openSections],
  );

  const paneStyle = (target: View): React.CSSProperties => ({
    display: view === target ? "flex" : "none",
    flex: 1,
    flexDirection: "column",
    overflow: "hidden",
  });

  const goTo = useCallback((v: View) => {
    setVisitedViews((prev) => (prev.has(v) ? prev : new Set(prev).add(v)));
    // Чат вкладкой раздела не считается: у него своя полоса диалогов.
    if (v !== "chat") {
      setOpenSections((prev) => (prev.includes(v) ? prev : [...prev, v]));
    }
    setView(v);
  }, []);

  /**
   * Закрыть вкладку раздела.
   *
   * Снимаем и с `visitedViews`: экран перестаёт быть смонтированным, и при
   * следующем открытии поднимется заново. Иначе закрытая вкладка продолжала бы
   * висеть в памяти и держать свои подписки — для «Канбана» и «Офиса» это
   * заметно.
   */
  const closeSection = useCallback((v: View) => {
    setOpenSections((prev) => prev.filter((x) => x !== v));
    setVisitedViews((prev) => {
      if (!prev.has(v)) return prev;
      const next = new Set(prev);
      next.delete(v);
      return next;
    });
    // Закрыли ту, на которую смотрим, — возвращаемся в чат: оставаться на
    // размонтированном экране означало бы пустое окно.
    setView((current) => (current === v ? "chat" : current));
  }, []);

  useEffect(() => {
    const handleNavigation = (e: Event): void => {
      const targetView = (e as CustomEvent<View>).detail;
      if (targetView) goTo(targetView);
    };
    window.addEventListener("navigation:goto", handleNavigation);
    return () =>
      window.removeEventListener("navigation:goto", handleNavigation);
  }, [goTo]);

  // Cmd/Ctrl+, opens the settings modal from anywhere (the conventional
  // "preferences" shortcut).
  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        openSettings(undefined, { profile: activeProfile });
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [openSettings, activeProfile]);

  const focusDiscover = useCallback(
    (kind: "skills" | "mcps") => {
      setDiscoverFocus((prev) => ({ kind, nonce: (prev?.nonce ?? 0) + 1 }));
      goTo("discover");
    },
    [goTo],
  );

  // Re-check remote mode on tab switch (picks up Settings changes)
  useEffect(() => {
    window.hermesAPI.isRemoteOnlyMode().then(setRemoteMode);
  }, [view]);

  // Restore the last-activated profile on launch. The main process persists it
  // in ~/.hermes/active_profile (via `hermes profile use`), so the desktop
  // should reopen on that profile rather than always resetting to "default".
  useEffect(() => {
    let cancelled = false;
    window.hermesAPI
      .listProfiles()
      .then((profiles) => {
        if (cancelled) return;
        const active = profiles.find((p) => p.isActive);
        if (active && active.name !== "default") {
          setActiveProfile(active.name);
          // Re-home the initial pristine run onto the restored profile so the
          // first chat runs under the right agent (no session/turn yet).
          setRuns((prev) =>
            prev.length === 1 && !prev[0].sessionId && !prev[0].loading
              ? [{ ...prev[0], profile: active.name }]
              : prev,
          );
        }
      })
      .catch(() => {
        /* fall back to the default profile */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-update state
  const [updateState, setUpdateState] = useState<
    "available" | "downloading" | "ready" | "error" | null
  >(null);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updatePercent, setUpdatePercent] = useState<number | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    // Surface a startup upgrade button as soon as GitHub reports a newer
    // release. If auto-upgrade is enabled, electron-updater also downloads in
    // the background and this state advances to downloading/ready.
    const cleanupAvailable = window.hermesAPI.onUpdateAvailable((info) => {
      setUpdateState("available");
      setUpdateVersion(info.version);
      setUpdateError(null);
    });
    const cleanupProgress = window.hermesAPI.onUpdateDownloadProgress(
      (info) => {
        setUpdateState("downloading");
        setUpdatePercent(info.percent);
        setUpdateError(null);
      },
    );
    const cleanupDownloaded = window.hermesAPI.onUpdateDownloaded(() => {
      setUpdateState("ready");
      setUpdatePercent(null);
      setUpdateError(null);
    });
    const cleanupError = window.hermesAPI.onUpdateError((message) => {
      setUpdateState("error");
      setUpdateError(message);
    });
    return () => {
      cleanupAvailable();
      cleanupProgress();
      cleanupDownloaded();
      cleanupError();
    };
  }, []);

  async function handleUpdate(): Promise<void> {
    if (updateState === "ready") {
      // The only user action: restart into the already-downloaded update.
      await window.hermesAPI.installUpdate();
    } else if (updateState === "available" || updateState === "error") {
      // Download the available update (or retry a failed auto-download).
      // Set downloading state immediately to prevent re-entrancy.
      setUpdateState("downloading");
      setUpdatePercent(null);
      setUpdateError(null);
      try {
        const ok = await window.hermesAPI.downloadUpdate();
        if (!ok) setUpdateState("error");
        // On success, we wait for the onUpdateDownloaded callback to set "ready"
      } catch (err) {
        setUpdateError(err instanceof Error ? err.message : String(err));
        setUpdateState("error");
      }
    }
  }

  const updateButtonTitle =
    updateError ??
    (updateState === "available" && updateVersion
      ? t("common.updateAvailable", { version: updateVersion })
      : updateState === "downloading"
        ? updatePercent === null
          ? t("common.downloading", { percent: 0 })
          : t("common.downloading", { percent: updatePercent })
        : updateState === "ready"
          ? t("common.restartToUpdate")
          : updateState === "error"
            ? t("common.updateFailed")
            : undefined);

  const handleNewChat = useCallback(() => {
    // Open a fresh run WITHOUT aborting others — any in-flight session keeps
    // streaming in the background and stays reachable via the active bar. If the
    // current chat is already a blank scratch, reuse it instead of stacking
    // another empty tab.
    const active = runs.find((r) => r.runId === activeRunId);
    if (active && !active.sessionId && !active.loading && !active.title) {
      goTo("chat");
      return;
    }
    const run = mintRun(activeProfile);
    setRuns((prev) => [...prev, run]);
    setActiveRunId(run.runId);
    goTo("chat");
  }, [runs, activeRunId, activeProfile, goTo]);

  // Listen for menu IPC events (Cmd+N, Cmd+K from app menu)
  useEffect(() => {
    const cleanupNewChat = window.hermesAPI.onMenuNewChat(() => {
      handleNewChat();
    });
    const cleanupSearch = window.hermesAPI.onMenuSearchSessions(() => {
      setSessionsModalOpen(true);
    });
    return () => {
      cleanupNewChat();
      cleanupSearch();
    };
  }, [handleNewChat]);

  // Esc closes the full-list sessions modal.
  useEffect(() => {
    if (!sessionsModalOpen) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setSessionsModalOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessionsModalOpen]);

  const handleSelectProfile = useCallback(
    (name: string) => {
      // Selecting an agent is administrative: switch the active profile (the
      // component already started its gateway via setActiveProfile). Existing
      // chats remain on their original profile, but the visible chat must move
      // to a scratch run for the selected profile so the footer and transport
      // never point at different agents.
      setActiveProfile(name);
      const next = selectProfileRunTransition(runs, activeRunId, name);
      setRuns(next.runs);
      setActiveRunId(next.activeRunId);
    },
    [runs, activeRunId],
  );

  // The "Chat" affordance: start (or reuse a blank) conversation with an agent
  // and show it. This is the only path from the profile list that opens a chat.
  const handleChatWithProfile = useCallback(
    (name: string) => {
      setActiveProfile(name);
      const active = runs.find((r) => r.runId === activeRunId);
      if (active && isScratchRun(active)) {
        setRuns((prev) =>
          prev.map((r) =>
            r.runId === active.runId ? { ...r, profile: name } : r,
          ),
        );
      } else {
        const run = mintRun(name);
        setRuns((prev) => [...prev, run]);
        setActiveRunId(run.runId);
      }
      goTo("chat");
    },
    [runs, activeRunId, goTo],
  );

  // Jump to an already-open run (e.g. from the active-sessions bar), switching
  // the selected profile so the rest of the app follows the agent.
  const handleActivateRun = useCallback(
    (runId: string) => {
      const run = runs.find((r) => r.runId === runId);
      if (!run) return;
      setActiveRunId(runId);
      setActiveProfile(run.profile);
      goTo("chat");
    },
    [runs, goTo],
  );

  // --- Переключение диалогов с клавиатуры ----------------------------------
  //
  // Комбинации внутриоконные, поэтому здесь всё честно: видно и нажатие, и
  // отпускание, и повторы — в отличие от глобальных хоткеев, которые система
  // перехватывает целиком.
  //
  // Списка два, и это осознанно. Цифры и Alt+стрелки ходят по верхней строке
  // вкладок — по тому порядку, который человек видит на экране, так что
  // «третья вкладка» и Ctrl+3 означают одно и то же. Ctrl+Tab ходит по
  // сайдбару: это уже не переключение открытых вкладок, а переход в историю,
  // и он может стоить загрузки переписки.
  const [switcher, setSwitcher] = useState<SwitcherState | null>(null);
  const [switchHotkey, setSwitchHotkey] = useState(SWITCH_CHAT_DEFAULT);
  const [nextChatHotkey, setNextChatHotkey] = useState(NEXT_CHAT_DEFAULT);
  const [prevChatHotkey, setPrevChatHotkey] = useState(PREV_CHAT_DEFAULT);
  // Список сайдбара поднят сюда: панель Ctrl+Tab показывает ровно его.
  const [sidebarSessions, setSidebarSessions] = useState<SwitcherItem[]>([]);
  const switcherRef = useRef<SwitcherState | null>(null);
  switcherRef.current = switcher;
  const runsRef = useRef<ChatRun[]>(runs);
  runsRef.current = runs;
  const activeRunIdRef = useRef(activeRunId);
  activeRunIdRef.current = activeRunId;
  // Свёрнутый сайдбар ничего не загружает — панель осталась бы пустой.
  // Читаем тот же кэш напрямую: это чтение JSON, без обращения к базе.
  const [cachedSessions, setCachedSessions] = useState<SwitcherItem[]>([]);
  const switcherItems =
    sidebarSessions.length >= 2 ? sidebarSessions : cachedSessions;
  const sidebarSessionsRef = useRef<SwitcherItem[]>(switcherItems);
  sidebarSessionsRef.current = switcherItems;
  const currentSessionIdRef = useRef<string | null>(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const activateRunRef = useRef(handleActivateRun);
  activateRunRef.current = handleActivateRun;
  // Присваивается ниже, сразу после объявления handleResumeSession: тот
  // объявлен позже по файлу, и взять его здесь напрямую нельзя.
  const resumeSessionRef = useRef<(sessionId: string) => Promise<void>>(
    async () => {},
  );

  // Сайдбар отдаёт свой список наверх. Он же решает, что такое «недавние»:
  // повторять эту сортировку здесь значило бы разойтись с тем, что видно.
  const handleSidebarSessions = useCallback((list: SwitcherItem[]): void => {
    setSidebarSessions((prev) => {
      if (
        prev.length === list.length &&
        prev.every((s, i) => s.id === list[i].id && s.title === list[i].title)
      ) {
        return prev;
      }
      return list;
    });
  }, []);

  useEffect(() => {
    if (sidebarSessions.length >= 2) return;
    let alive = true;
    void window.hermesAPI
      .listCachedSessions(SWITCHER_LIMIT, 0, undefined, activeProfile)
      .then((rows) => {
        if (!alive) return;
        setCachedSessions(rows.map(({ id, title }) => ({ id, title })));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // currentSessionId в зависимостях намеренно: переключение диалога меняет
    // порядок «недавних», и к следующему нажатию список должен быть свежим.
  }, [sidebarSessions.length, activeProfile, currentSessionId]);

  useEffect(() => {
    void window.hermesAPI
      .getHotkeys?.()
      .then((h) => {
        if (h?.switchChat) setSwitchHotkey(h.switchChat);
        if (h?.nextChat) setNextChatHotkey(h.nextChat);
        if (h?.prevChat) setPrevChatHotkey(h.prevChat);
        if (h?.insertDraft) setInsertHotkey(h.insertDraft);
      })
      .catch(() => undefined);
  }, []);

  // --- Черновики, ожидающие диалога ----------------------------------------
  //
  // Комбинации снимка и диктовки глобальные: их нажимают, глядя в чужое окно,
  // и какой диалог открыт в этот момент — случайность. Поэтому сделанное
  // задерживается здесь, в Layout, а не уезжает в чат сразу: карточка должна
  // пережить смену диалога, ради чего всё и затевалось.
  const [drafts, setDrafts] = useState<PendingDraft[]>([]);
  const [insertHotkey, setInsertHotkey] = useState(INSERT_DRAFT_DEFAULT);
  /** Почему черновик не уехал в чат — показываем прямо в карточке. */
  const [draftError, setDraftError] = useState<string | null>(null);
  const draftsRef = useRef<PendingDraft[]>(drafts);
  draftsRef.current = drafts;
  // Ждём ли текст от распознавания — этим поле ввода подменяет подсказку,
  // чтобы пустая строка с курсором не читалась как «ничего не записалось».
  // Флаг производный от стека черновиков (см. isRecognizing), поэтому он не
  // может разъехаться с карточкой, и уходит во все вкладки, а не только в
  // активную: распознавание одно на приложение, и если переключиться на
  // соседний чат, пока оно идёт, подсказка должна быть и там.
  const dictationPending = isRecognizing(drafts);
  /** Строка заметки, которая сейчас распознаётся: ответ придёт отдельно. */
  const recognizingIdRef = useRef<string | null>(null);

  const newDraftId = (): string =>
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  useEffect(() => {
    const subscribe = window.hermesAPI?.onScreenshotCaptured;
    if (typeof subscribe !== "function") return;
    return subscribe((shot) => {
      if (!shot?.png) return;
      const name = shot.name || "screenshot.png";
      const file = new File([shot.png], name, { type: "image/png" });
      setDrafts((prev) =>
        pushDraft(prev, {
          id: newDraftId(),
          kind: "image",
          name,
          url: URL.createObjectURL(file),
          file,
          at: Date.now(),
        }),
      );
    });
  }, []);

  // Диктовка. Строка появляется сразу по отпусканию клавиш, с пометкой
  // «распознавание», и достраивается текстом, когда сайдкар ответит: иначе
  // между записью и текстом человек секунду-другую смотрит в пустоту и не
  // понимает, записалось ли что-нибудь.
  useEffect(() => {
    const onPending = window.hermesAPI?.onDictationPending;
    const onText = window.hermesAPI?.onDictationText;
    const onDropped = window.hermesAPI?.onDictationDropped;
    if (typeof onText !== "function") return;

    const offPending =
      typeof onPending === "function"
        ? onPending(() => {
            const id = newDraftId();
            recognizingIdRef.current = id;
            setDrafts((prev) =>
              pushDraft(prev, {
                id,
                kind: "text",
                text: "",
                state: "recognizing",
                at: Date.now(),
              }),
            );
          })
        : () => undefined;

    const offText = onText((text: string) => {
      const id = recognizingIdRef.current;
      recognizingIdRef.current = null;
      if (!id) return;
      setDrafts((prev) => resolveTextDraft(prev, id, text));
    });

    const offDropped =
      typeof onDropped === "function"
        ? onDropped(() => {
            const id = recognizingIdRef.current;
            recognizingIdRef.current = null;
            if (id) setDrafts((prev) => removeDraft(prev, id));
          })
        : () => undefined;

    return () => {
      offPending();
      offText();
      offDropped();
    };
  }, []);

  // Вставка идёт событием окна, а не пропсом: вкладки смонтированы все сразу,
  // и принять снимок должна ровно та, что сейчас на экране. Guard по `active`
  // живёт в самом чате — там же, где остальные такие подписки.
  //
  // Чат подтверждает приём и отдаёт обещание разбора. Пока оно не выполнено,
  // черновик остаётся в карточке с пометкой: разбор асинхронный, и если
  // убирать его сразу, человек успеет отправить сообщение раньше, чем
  // вложение окажется в поле ввода, — и не поймёт, куда оно делось.
  const insertDraft = useCallback(
    (id: string): void => {
      const draft = draftsRef.current.find((d) => d.id === id);
      if (!draft || !isInsertable(draft)) return;
      setDraftError(null);
      setDrafts((prev) => markInserting(prev, id, true));

      let taken = false;
      const accept = (result: Promise<AttachmentError[]>): void => {
        taken = true;
        result
          .then((errors) => {
            if (errors.length > 0) {
              console.warn("[DRAFT] the open tab refused the draft", errors);
              setDrafts((prev) => markInserting(prev, id, false));
              setDraftError(t("chat.drafts.insertFailed"));
              return;
            }
            console.log("[DRAFT] inserted into the open tab:", draft.kind);
            setDrafts((prev) => removeDraft(prev, id));
          })
          .catch((err) => {
            console.warn("[DRAFT] insert failed", err);
            setDrafts((prev) => markInserting(prev, id, false));
            setDraftError(t("chat.drafts.insertFailed"));
          });
      };

      window.dispatchEvent(
        new CustomEvent("hermes-insert-draft", {
          detail:
            draft.kind === "image" || draft.kind === "file"
              ? { files: [draft.file], accept }
              : { text: draft.text, accept },
        }),
      );

      // Событие рассылается синхронно: если к этой строке никто не отозвался,
      // открытого чата, готового принять черновик, просто нет.
      if (!taken) {
        // Ни чат, ни блокнот не отозвались: открытой вкладки, готовой
        // принять черновик, сейчас нет.
        console.warn("[DRAFT] no tab accepted the draft");
        setDrafts((prev) => markInserting(prev, id, false));
        setDraftError(t("chat.drafts.insertNoChat"));
      }
    },
    [t],
  );

  /**
   * Заметка, отправленная из блокнота, кладётся в ту же карточку, что снимки
   * и диктовка, а не вставляется в диалог сама.
   *
   * Так человек сам решает, куда она пойдёт: карточка переживает смену
   * вкладки, и из неё можно вставить в любой диалог — или вернуться в
   * блокнот и вставить обратно в другую заметку. Прежний вариант выбирал
   * диалог за человека и уводил его из блокнота, даже если он просто хотел
   * отложить заметку под рукой.
   *
   * Текст и каждое вложение идут отдельными строками: вставляются они тоже
   * по одной, и человеку может понадобиться не всё сразу.
   */
  const sendNoteToTray = useCallback((text: string, files: File[]): void => {
    setDraftError(null);
    const at = Date.now();
    setDrafts((prev) => {
      let next = prev;
      // Файлы кладём первыми, текст последним: pushDraft кладёт наверх, и
      // текст заметки должен оказаться над своими вложениями.
      for (const file of files) {
        // Картинке нужна ссылка на блоб — под миниатюру и полноразмерный
        // просмотр; остальным файлам показывать нечего, и ссылку, которую
        // потом пришлось бы отзывать, им не заводим.
        next = pushDraft(
          next,
          file.type.startsWith("image/")
            ? {
                id: newDraftId(),
                kind: "image",
                name: file.name,
                url: URL.createObjectURL(file),
                file,
                at,
              }
            : { id: newDraftId(), kind: "file", name: file.name, file, at },
        );
      }
      if (text) {
        next = pushDraft(next, {
          id: newDraftId(),
          kind: "text",
          text,
          state: "ready",
          at,
        });
      }
      return next;
    });
  }, []);

  const removeDraftById = useCallback((id: string): void => {
    setDraftError(null);
    setDrafts((prev) => removeDraft(prev, id));
  }, []);

  const clearAllDrafts = useCallback((): void => {
    setDraftError(null);
    setDrafts((prev) => clearDrafts(prev));
  }, []);

  // Внутриоконные комбинации, пойманные главным процессом: на Windows слой
  // окна разбирает сочетания с Alt раньше страницы, и до обработчика ниже они
  // не доходят.
  useEffect(() => {
    return window.hermesAPI.onWindowHotkey?.((action) => {
      if (action === "insertDraft") {
        // Верхний готовый: заметка, которая ещё распознаётся, не вставляется.
        const top = draftsRef.current.find(isInsertable);
        if (top) insertDraft(top.id);
        return;
      }
      const target = neighbourRunId(
        runsRef.current.map((r) => r.runId),
        activeRunIdRef.current,
        action === "prevChat",
      );
      if (target && target !== activeRunIdRef.current) {
        activateRunRef.current(target);
      }
    });
  }, [insertDraft]);

  useEffect(() => {
    const runIds = (): string[] => runsRef.current.map((r) => r.runId);

    const onKeyDown = (event: KeyboardEvent): void => {
      // Цифра — прямой переход к вкладке с этим номером в верхней строке.
      // Нумерация буквальная: десятой и дальше по цифрам не добраться, для
      // них есть стрелки.
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (
        digit &&
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        const target = runIdAtPosition(runIds(), Number(digit[1]));
        if (!target) return;
        event.preventDefault();
        activateRunRef.current(target);
        return;
      }

      // Соседняя вкладка по порядку строки, с зацикливанием.
      const forward = matchesAccelerator(event, nextChatHotkey);
      const back = !forward && matchesAccelerator(event, prevChatHotkey);
      if (forward || back) {
        const target = neighbourRunId(runIds(), activeRunIdRef.current, back);
        if (!target || target === activeRunIdRef.current) {
          // Одна вкладка — гасим нажатие всё равно: иначе Alt+стрелка уедет
          // в поле ввода и подвинет там каретку.
          event.preventDefault();
          return;
        }
        event.preventDefault();
        activateRunRef.current(target);
        return;
      }

      if (!matchesAccelerator(event, switchHotkey, true)) return;
      event.preventDefault();
      const backwards = event.shiftKey;
      const open = switcherRef.current;
      const next = open
        ? advance(open, backwards)
        : openSwitcher(
            sidebarSessionsRef.current,
            currentSessionIdRef.current,
            backwards,
            SWITCHER_LIMIT,
          );
      if (next) setSwitcher(next);
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      const open = switcherRef.current;
      if (!open) return;
      // Переключение завершает отпускание модификатора — ровно как у Alt+Tab.
      if (!acceleratorModifiers(switchHotkey).includes(event.key)) return;
      setSwitcher(null);
      const target = open.items[open.index];
      // Диалог из сайдбара может быть ещё не открыт — тогда это загрузка
      // истории, и её берёт на себя обычный путь открытия сессии.
      if (target) void resumeSessionRef.current(target.id);
    };

    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && switcherRef.current) setSwitcher(null);
    };

    const onBlur = (): void => setSwitcher(null);

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keydown", onEscape);
    window.addEventListener("keyup", onKeyUp);
    // Окно потеряло фокус с зажатой комбинацией — отпускания мы не увидим.
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keydown", onEscape);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [switchHotkey, nextChatHotkey, prevChatHotkey]);

  // Close a conversation tab: stop it if it's running, drop it from the list,
  // and (if it was active) move to a neighbour. Always keep at least one chat
  // open so the chat view is never empty.
  const handleCloseRun = useCallback(
    (runId: string) => {
      window.hermesAPI.abortChat(runId);
      const idx = runs.findIndex((r) => r.runId === runId);
      const remaining = runs.filter((r) => r.runId !== runId);
      if (remaining.length === 0) {
        const fresh = mintRun(activeProfile);
        setRuns([fresh]);
        setActiveRunId(fresh.runId);
        return;
      }
      setRuns(remaining);
      if (runId === activeRunId) {
        const neighbour = remaining[Math.min(idx, remaining.length - 1)];
        setActiveRunId(neighbour.runId);
        setActiveProfile(neighbour.profile);
      }
    },
    [runs, activeRunId, activeProfile],
  );

  const handleResumeSession = useCallback(
    async (sessionId: string) => {
      // Already open as a live run? Re-attach to it (keeps live streaming).
      const live = findRunBySession(runs, sessionId);
      if (live) {
        handleActivateRun(live.runId);
        return;
      }
      // Guard against a double-click resuming the same session twice: the live
      // check above and the setRuns below straddle an await, so without this a
      // second click would pass the stale guard and mount a duplicate tab.
      if (resumingRef.current.has(sessionId)) return;
      resumingRef.current.add(sessionId);
      setResumingSessionId(sessionId);
      try {
        const items = (await window.hermesAPI.getSessionMessages(
          sessionId,
          undefined,
          activeProfile,
        )) as DbHistoryItem[];
        const run = mintRun(activeProfile, dbItemsToChatMessages(items));
        run.sessionId = sessionId;
        run.fromHistory = true;
        setRuns(
          (prev) => openSessionRunTransition(prev, activeRunId, run).runs,
        );
        setActiveRunId(run.runId);
        goTo("chat");
      } finally {
        resumingRef.current.delete(sessionId);
        setResumingSessionId(null);
      }
    },
    [runs, activeRunId, handleActivateRun, activeProfile, goTo],
  );
  resumeSessionRef.current = handleResumeSession;

  // Запуск начинается с чистого нового диалога.
  //
  // Раньше приложение открывало последний диалог: список сессий тогда жил
  // только на сервере, и пустой стартовый чат их прятал. Сейчас недавние
  // диалоги видны в сайдбаре, так что восстанавливать что-то за человека
  // незачем — он сам выберет, продолжать старое или начать новое. А выбор за
  // него приложение всё равно делало плохо: запоминался не тот диалог, в
  // котором работали последним, а тот, чья вкладка смонтировалась позже.

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {
        /* ignore persistence failures */
      }
      return next;
    });
  }, []);

  const sidebarToggleLabel = sidebarCollapsed
    ? t("navigation.expandSidebar")
    : t("navigation.collapseSidebar");

  return (
    <div className={`layout ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <SidebarBrand />
          <button
            className="sidebar-collapse-toggle"
            type="button"
            onClick={toggleSidebar}
            title={sidebarToggleLabel}
            aria-label={sidebarToggleLabel}
            aria-expanded={!sidebarCollapsed}
          >
            {sidebarCollapsed ? (
              // Collapsed: show the circular brand mark by default and swap to
              // the expand icon on hover/focus. Both sit in a fixed-size box so
              // the swap never changes the button's footprint.
              <span className="sidebar-collapse-swap">
                <span className="sidebar-collapse-mark" aria-hidden="true" />
                <PanelLeftOpen
                  size={16}
                  className="sidebar-collapse-expand-icon"
                />
              </span>
            ) : (
              <PanelLeftClose size={16} />
            )}
          </button>
        </div>

        <nav className="sidebar-nav sidebar-nav-pinned">
          <button
            className={`sidebar-nav-item sidebar-new-chat ${
              view === "chat" && currentSessionId === null ? "active" : ""
            }`}
            onClick={handleNewChat}
            title={t("navigation.newChat")}
            aria-label={t("navigation.newChat")}
          >
            <Plus size={16} />
            <span className="sidebar-nav-label">{t("navigation.newChat")}</span>
          </button>
          {PINNED_NAV_ITEMS.map(({ view: v, icon: Icon, labelKey }) => {
            return (
              <button
                key={v}
                className={`sidebar-nav-item ${view === v ? "active" : ""}`}
                onClick={() => goTo(v)}
                title={t(labelKey)}
                aria-label={t(labelKey)}
              >
                <Icon size={16} />
                <span className="sidebar-nav-label">{t(labelKey)}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-chat-section">
          <div className="sidebar-nav-sessions">
            <div className="sidebar-chat-scroll" ref={sidebarChatScrollRef}>
              <SidebarRecentSessions
                open={!sidebarCollapsed}
                activeProfile={activeProfile}
                currentSessionId={currentSessionId}
                loadingSessionIds={loadingSessionIds}
                resumingSessionId={resumingSessionId}
                onSelect={handleResumeSession}
                onSessionsChange={handleSidebarSessions}
                onSessionDeleted={(id) => {
                  // If the open chat was the one deleted, drop to a fresh chat
                  // so the user isn't left viewing a now-gone conversation.
                  if (id === currentSessionId) handleNewChat();
                }}
                scrollRootRef={sidebarChatScrollRef}
              />
            </div>
            {sidebarScrollbar.scrollable && (
              <div
                className={`sidebar-chat-scrollbar ${
                  sidebarScrollbar.visible ? "visible" : ""
                }`}
                aria-hidden="true"
              >
                <div
                  className="sidebar-chat-scrollbar-thumb"
                  style={{
                    height: sidebarScrollbar.height,
                    transform: `translateY(${sidebarScrollbar.top}px)`,
                  }}
                />
              </div>
            )}
          </div>
        </div>

        <div className="sidebar-footer">
          {/* Show an upgrade affordance at startup when GitHub has a newer
              release; it becomes a restart action once downloaded. */}
          {updateState && (
            <button
              className={`sidebar-update-btn ${
                updateState === "error" ? "error" : ""
              }`}
              onClick={handleUpdate}
              disabled={updateState === "downloading"}
              title={updateButtonTitle}
              aria-label={updateButtonTitle}
            >
              <Download size={13} />
              {updateState === "available" && (
                <span>
                  {updateVersion
                    ? t("common.updateAvailable", { version: updateVersion })
                    : t("common.updateAvailable", { version: "" })}
                </span>
              )}
              {updateState === "downloading" && (
                <span>
                  {t("common.downloading", { percent: updatePercent ?? 0 })}
                </span>
              )}
              {updateState === "ready" && (
                <span>{t("common.restartToUpdate")}</span>
              )}
              {updateState === "error" && (
                <span>{t("common.updateFailed")}</span>
              )}
            </button>
          )}
          <div className="sidebar-footer-actions" aria-label="Workspace tools">
            {FOOTER_NAV_ITEMS.map(({ view: v, icon: Icon, labelKey }) => (
              <button
                key={v}
                className={`sidebar-footer-action ${view === v ? "active" : ""}`}
                onClick={() => goTo(v)}
                aria-label={t(labelKey)}
                data-tooltip={t(labelKey)}
              >
                <Icon size={16} />
              </button>
            ))}
            <button
              className="sidebar-footer-action"
              onClick={() =>
                openSettings(undefined, { profile: activeProfile })
              }
              aria-label={t("navigation.settings")}
              data-tooltip={t("navigation.settings")}
            >
              <SettingsIcon size={16} />
            </button>
          </div>
          <ProfileSwitcher
            activeProfile={activeProfile}
            onSwitch={handleSelectProfile}
            // Профилями в гибриде распоряжается организация, а экран управления
            // ими показывает ту же заглушку. Прячем пункт, а не ведём в тупик.
            onManage={remoteMode ? undefined : () => goTo("agents")}
            compact={sidebarCollapsed}
          />
        </div>
      </aside>

      <main className="content">
        {switcher && <ChatSwitcherOverlay state={switcher} />}
        <DraftTray
          drafts={drafts}
          insertHotkey={formatAccelerator(insertHotkey)}
          error={draftError}
          onInsert={insertDraft}
          onRemove={removeDraftById}
          onClear={clearAllDrafts}
        />
        {/* Doubles as the window drag strip — keep it first so it owns the top
            band; the warning banner (if any) sits just below it. */}
        <ActiveSessionsBar
          runs={runs}
          activeRunId={activeRunId}
          onSelect={handleActivateRun}
          onClose={handleCloseRun}
          onNew={handleNewChat}
          getAppearance={getAppearance}
          sections={sectionTabs}
          activeView={view}
          onSelectSection={(v) => goTo(v as View)}
          onCloseSection={(v) => closeSection(v as View)}
        />
        {verifyWarning && onReinstall && onDismissVerifyWarning && (
          <VerifyWarningBanner
            onReinstall={onReinstall}
            onDismiss={onDismissVerifyWarning}
          />
        )}
        <div style={paneStyle("chat")}>
          {runs.map((run) => (
            <div
              key={run.runId}
              style={{
                display:
                  view === "chat" && run.runId === activeRunId
                    ? "flex"
                    : "none",
                flex: 1,
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              <Chat
                runId={run.runId}
                initialMessages={run.seed}
                initialSessionId={run.sessionId}
                active={run.runId === activeRunId}
                onScreen={view === "chat"}
                profile={run.profile}
                dictationPending={dictationPending}
                onNewChat={handleNewChat}
                onOpenDiagnose={(section?: string) =>
                  openSettings(section, { profile: run.profile })
                }
                onLoadingChange={handleRunLoading}
                onSessionIdChange={handleRunSessionId}
                onTitleChange={handleRunTitle}
              />
            </div>
          ))}
        </div>

        {sessionsModalOpen && (
          <div
            className="models-modal-overlay"
            onClick={() => setSessionsModalOpen(false)}
          >
            <div
              className="sessions-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <Sessions
                profile={activeProfile}
                onResumeSession={(id) => {
                  setSessionsModalOpen(false);
                  void handleResumeSession(id);
                }}
                onNewChat={() => {
                  setSessionsModalOpen(false);
                  handleNewChat();
                }}
                currentSessionId={currentSessionId}
                visible={sessionsModalOpen}
              />
            </div>
          </div>
        )}

        {visitedViews.has("discover") && (
          <div style={paneStyle("discover")}>
            {remoteMode ? (
              <Overview
                visible={view === "discover"}
                onNavigate={(v) => goTo(v as View)}
                onNewChat={handleNewChat}
              />
            ) : (
              <Discover
                profile={activeProfile}
                visible={view === "discover"}
                focusKind={discoverFocus ?? undefined}
              />
            )}
          </div>
        )}

        {visitedViews.has("agents") && (
          <div style={paneStyle("agents")}>
            {remoteMode ? (
              <RemoteNotice feature="Profiles" />
            ) : (
              <Agents
                activeProfile={activeProfile}
                onSelectProfile={handleSelectProfile}
                onChatWith={handleChatWithProfile}
              />
            )}
          </div>
        )}

        {visitedViews.has("staff") && (
          <div style={paneStyle("staff")}>
            <Staff visible={view === "staff"} />
          </div>
        )}

        {visitedViews.has("providers") && (
          <div style={paneStyle("providers")}>
            {remoteMode ? (
              <RemoteNotice feature="Providers" />
            ) : (
              <Providers
                profile={activeProfile}
                visible={view === "providers"}
              />
            )}
          </div>
        )}

        {visitedViews.has("skills") && (
          <div style={paneStyle("skills")}>
            <Skills profile={activeProfile} />
          </div>
        )}

        {visitedViews.has("memory") && (
          <div style={paneStyle("memory")}>
            {remoteMode ? (
              // В гибриде показываем личный банк памяти с сервера, а не
              // заглушку: путь до него построен, банк существует и наполняется.
              <MemoryBank />
            ) : (
              <Memory profile={activeProfile} />
            )}
          </div>
        )}

        {visitedViews.has("notes") && (
          <div style={paneStyle("notes")}>
            <Notes active={view === "notes"} onSendToTray={sendNoteToTray} />
          </div>
        )}

        {visitedViews.has("tools") && (
          <div style={paneStyle("tools")}>
            <Tools
              profile={activeProfile}
              showPlatformToolsets={!remoteMode}
              remoteMode={remoteMode}
              visible={view === "tools"}
              onBrowseSkills={() => focusDiscover("skills")}
              onBrowseMcps={() => focusDiscover("mcps")}
            />
          </div>
        )}

        {visitedViews.has("schedules") && (
          <div style={paneStyle("schedules")}>
            <Schedules profile={activeProfile} />
          </div>
        )}

        {visitedViews.has("kanban") && (
          <div style={paneStyle("kanban")}>
            <Kanban profile={activeProfile} visible={view === "kanban"} />
          </div>
        )}

        {visitedViews.has("gateway") && (
          <div style={paneStyle("gateway")}>
            {remoteMode ? (
              <RemoteNotice feature="Gateway" />
            ) : (
              <Gateway profile={activeProfile} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default Layout;
