export default {
  title: "Personel AI",
  subtitle: "Agenci na serwerze, każdy z własną tablicą.",
  empty: "Nie ma jeszcze agentów.",
  back: "Do wszystkich",
  newTask: "Nowe zadanie",
  taskTitle: "Tytuł zadania",
  taskBody: "Co trzeba zrobić",
  assign: "Zleć",
  tasks: "Zadania",
  noTasks: "Nie ma jeszcze zadań.",
  approve: "Zatwierdź",
  changes: "Poproś o zmiany",
  reject: "Odrzuć",
  loadFailed: "Nie udało się wczytać listy.",
  boardFailed: "Nie udało się wczytać tablicy.",
  createFailed:
    "Agent nie przyjął zadania — usterka jest po jego stronie, nie w aplikacji.",
  /** Вердикт уходит комментарием в задачу сотрудника. */
  verdict: {
    approve: "✅ Zatwierdzone",
    changes: "🔄 Wymagane poprawki",
    reject: "❌ Odrzucone",
  },
} as const;
