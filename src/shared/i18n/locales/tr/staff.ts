export default {
  title: "Yapay zekâ ekibi",
  subtitle: "Sunucudaki ajanlar, her birinin kendi panosu var.",
  empty: "Henüz ajan yok.",
  back: "Tümüne",
  newTask: "Yeni görev",
  taskTitle: "Görev başlığı",
  taskBody: "Ne yapılmalı",
  assign: "Ata",
  tasks: "Görevler",
  noTasks: "Henüz görev yok.",
  approve: "Onayla",
  changes: "Düzeltme iste",
  reject: "Reddet",
  loadFailed: "Liste yüklenemedi.",
  boardFailed: "Pano yüklenemedi.",
  createFailed:
    "Ajan görevi kabul etmedi — sorun uygulamada değil, onun tarafında.",
  /** Вердикт уходит комментарием в задачу сотрудника. */
  verdict: {
    approve: "✅ Onaylandı",
    changes: "🔄 Düzeltme isteniyor",
    reject: "❌ Reddedildi",
  },
} as const;
