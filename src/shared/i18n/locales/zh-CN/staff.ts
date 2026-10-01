export default {
  title: "AI 员工",
  subtitle: "服务器上的智能体，各自有自己的任务板。",
  empty: "还没有智能体。",
  back: "返回列表",
  newTask: "新建任务",
  taskTitle: "任务标题",
  taskBody: "需要做什么",
  assign: "指派",
  tasks: "任务",
  noTasks: "还没有任务。",
  approve: "通过",
  changes: "要求修改",
  reject: "驳回",
  loadFailed: "无法加载列表。",
  boardFailed: "无法加载任务板。",
  createFailed: "该智能体没有接受任务——问题出在它那一侧，不在应用。",
  /** Вердикт уходит комментарием в задачу сотрудника. */
  verdict: {
    approve: "✅ 已通过",
    changes: "🔄 需要修改",
    reject: "❌ 已驳回",
  },
} as const;
