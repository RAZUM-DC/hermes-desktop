export default {
  title: "Канбан",
  subtitle:
    "Устойчивая мультиагентная доска для задач, которые агент может взять и довести до конца сам.",

  // Header actions
  refresh: "Обновить",
  refreshTooltip: "Перезагрузить доски и задачи от агента",
  dispatch: "Диспетчер",
  dispatchTooltip:
    "Выполнить один проход диспетчера — продвинуть готовые задачи и запустить исполнителей",
  newTask: "Новая задача",
  newTaskTooltip: "Создать новую задачу на текущей доске",
  newBoard: "Новая доска",
  newBoardTooltip: "Создать новую канбан-доску",
  showArchived: "Показать архив",
  hideArchived: "Скрыть архив",
  archivedTooltip: "Переключить колонку архива",

  // Remote-mode unsupported notice
  remoteUnsupportedTitle:
    "Канбан требует локальной установки Hermes или режима SSH-туннеля.",
  remoteUnsupportedHint:
    "Обычный удалённый режим (HTTP + API-ключ) пока не предоставляет API канбана. Переключитесь на локальный режим или SSH-туннель в параметрах, чтобы управлять доской.",

  // Column / task statuses
  status: {
    triage: "Сортировка",
    todo: "К работе",
    scheduled: "Запланировано",
    ready: "К запуску",
    running: "Выполняется",
    blocked: "Заблокировано",
    review: "Проверка",
    done: "Завершено",
    archived: "Архив",
  },

  // Card action tooltips
  cardSpecify: "Уточнить (развернуть спецификацию → к работе)",
  cardMarkDone: "Отметить выполненной",
  cardReclaim: "Вернуть исполнителя",
  cardUnblock: "Разблокировать",
  cardBlock: "Заблокировать",
  cardArchive: "В архив",

  // Create-task modal
  createTitle: "Новая задача канбана",
  fieldTitle: "Заголовок",
  titlePlaceholder: "Что нужно сделать?",
  fieldBody: "Описание (необязательно)",
  bodyPlaceholder: "Контекст, критерии приёмки, ссылки…",
  fieldAssignee: "Профиль исполнителя",
  assigneeNone: "— Сортировка (без исполнителя)",
  fieldPriority: "Приоритет",
  priorityNormal: "Обычный (0)",
  priorityLow: "Низкий (P2)",
  priorityHigh: "Высокий (P1)",
  priorityUrgent: "Срочный (P0)",
  fieldWorkspace: "Рабочая область",
  workspaceScratch: "Временная (temp-каталог)",
  workspaceWorktree: "Worktree (текущий репозиторий)",
  workspaceChoose: "Выбрать папку…",
  workspaceNoFolder: "Папка не выбрана",
  localFolderLabel: "Локальная папка на ПК (необязательно)",
  localFolderPlaceholder: "напр. Downloads/Договоры",
  localFolderHint:
    "Путь относительно корня Documents / Downloads / Desktop. Задача выполняется на сервере, но ассистент читает и сохраняет файлы в этой папке ПК через локальные инструменты. Приложение должно быть запущено.",
  browse: "Обзор…",
  triageCheckbox:
    "Оставить в сортировке (уточнитель развернёт спецификацию перед продвижением к работе)",
  create: "Создать задачу",
  creating: "Создание…",

  // New-board modal
  newBoardTitle: "Новая доска",
  fieldSlug: "Слаг",
  slugPlaceholder: "kebab-case, напр. atm10-server",
  fieldDisplayName: "Отображаемое имя (необязательно)",
  displayNamePlaceholder: "ATM10 Server",
  createBoard: "Создать доску",

  // Task-detail modal
  detailFallbackTitle: "Задача",
  detailBody: "Описание",
  detailSummary: "Сводка последнего запуска",
  detailResult: "Результат",
  detailComments: "Комментарии ({{count}})",
  detailEvents: "События ({{count}})",
  commentAnon: "аноним",

  // Prompts / confirmations
  blockReasonPrompt: "Причина блокировки?",
  confirmMarkDone: 'Отметить «{{title}}» выполненной?',
  confirmArchive: 'Архивировать «{{title}}»?',

  // Errors
  moveNotAllowed:
    "Нельзя переместить {{from}} → {{to}} из десктопа. Используйте агента или CLI.",
  errLoadBoards: "Не удалось загрузить доски",
  errLoadTasks: "Не удалось загрузить задачи",
  errMoveTask: "Не удалось переместить задачу",
  errPickFolder: "Сначала выберите папку рабочей области.",
  errCreateTask: "Не удалось создать задачу",
  errSwitchBoard: "Не удалось переключить доску",
  errCreateBoard: "Не удалось создать доску",
  errSpecify: "Не удалось уточнить задачу",
  errArchive: "Не удалось архивировать задачу",
  errReclaim: "Не удалось вернуть исполнителя",
  errDispatch: "Сбой диспетчера",

  // Tooltips & buttons
  hqBoardTooltip: "Главная доска Claw3D (зеркало только для чтения)",
  dismissError: "Закрыть ошибку",
  closeTaskDetails: "Закрыть детали задачи",
} as const;
