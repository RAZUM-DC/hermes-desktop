export default {
  title: "Personal de IA",
  subtitle: "Agentes en el servidor, cada uno con su tablero.",
  empty: "Aún no hay agentes.",
  back: "A todos",
  newTask: "Nueva tarea",
  taskTitle: "Título de la tarea",
  taskBody: "Qué hay que hacer",
  assign: "Asignar",
  tasks: "Tareas",
  noTasks: "Aún no hay tareas.",
  approve: "Aprobar",
  changes: "Pedir cambios",
  reject: "Rechazar",
  loadFailed: "No se pudo cargar la lista.",
  boardFailed: "No se pudo cargar el tablero.",
  createFailed:
    "El agente no aceptó la tarea: el fallo está de su lado, no en la aplicación.",
  /** Вердикт уходит комментарием в задачу сотрудника. */
  verdict: {
    approve: "✅ Aprobado",
    changes: "🔄 Cambios solicitados",
    reject: "❌ Rechazado",
  },
} as const;
