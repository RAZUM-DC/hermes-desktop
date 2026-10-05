export default {
  title: "AIスタッフ",
  subtitle: "サーバー上のエージェント。それぞれに自分のボードがあります。",
  empty: "エージェントはまだいません。",
  back: "一覧へ",
  newTask: "新しいタスク",
  taskTitle: "タスク名",
  taskBody: "やってほしいこと",
  assign: "依頼する",
  tasks: "タスク",
  noTasks: "タスクはまだありません。",
  approve: "承認",
  changes: "修正を依頼",
  reject: "却下",
  loadFailed: "一覧を読み込めませんでした。",
  boardFailed: "ボードを読み込めませんでした。",
  createFailed:
    "エージェントがタスクを受け付けませんでした。アプリではなくエージェント側の不具合です。",
  /** Вердикт уходит комментарием в задачу сотрудника. */
  verdict: {
    approve: "✅ 承認",
    changes: "🔄 修正依頼",
    reject: "❌ 却下",
  },
} as const;
