export default {
  title: "AI staff",
  subtitle: "Agents on the server, each with a board of their own.",
  empty: "No staff agents yet.",
  back: "All staff",
  newTask: "New task",
  taskTitle: "Task title",
  taskBody: "What needs doing",
  assign: "Assign",
  tasks: "Tasks",
  noTasks: "No tasks yet.",
  approve: "Approve",
  changes: "Request changes",
  reject: "Reject",
  loadFailed: "Couldn't load the staff list.",
  boardFailed: "Couldn't load the board.",
  createFailed: "The agent did not accept the task — this is a fault on its side, not in the app.",
  /** Вердикт уходит комментарием в задачу сотрудника. */
  verdict: {
    approve: "✅ Approved",
    changes: "🔄 Changes requested",
    reject: "❌ Rejected",
  },
} as const;
