export default {
  title: "AI 員工",
  subtitle: "伺服器上的代理，各自有自己的任務板。",
  empty: "還沒有代理。",
  back: "返回列表",
  newTask: "新增任務",
  taskTitle: "任務標題",
  taskBody: "需要做什麼",
  assign: "指派",
  tasks: "任務",
  noTasks: "還沒有任務。",
  approve: "通過",
  changes: "要求修改",
  reject: "駁回",
  loadFailed: "無法載入列表。",
  boardFailed: "無法載入任務板。",
  createFailed: "該代理沒有接受任務——問題出在它那一側，不在應用程式。",
  /** Вердикт уходит комментарием в задачу сотрудника. */
  verdict: {
    approve: "✅ 已通過",
    changes: "🔄 需要修改",
    reject: "❌ 已駁回",
  },
} as const;
