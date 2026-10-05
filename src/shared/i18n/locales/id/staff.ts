export default {
  title: "Staf AI",
  subtitle: "Agen di server, masing-masing punya papan sendiri.",
  empty: "Belum ada agen.",
  back: "Ke semua",
  newTask: "Tugas baru",
  taskTitle: "Judul tugas",
  taskBody: "Apa yang perlu dikerjakan",
  assign: "Tugaskan",
  tasks: "Tugas",
  noTasks: "Belum ada tugas.",
  approve: "Setujui",
  changes: "Minta perbaikan",
  reject: "Tolak",
  loadFailed: "Gagal memuat daftar.",
  boardFailed: "Gagal memuat papan.",
  createFailed:
    "Agen tidak menerima tugas — masalahnya ada di sisi agen, bukan di aplikasi.",
  /** Вердикт уходит комментарием в задачу сотрудника. */
  verdict: {
    approve: "✅ Disetujui",
    changes: "🔄 Perlu perbaikan",
    reject: "❌ Ditolak",
  },
} as const;
