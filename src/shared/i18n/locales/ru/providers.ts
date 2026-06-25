export default {
  title: "Провайдеры",
  subtitle: "Настройка LLM-провайдеров, API-ключей и пулов учётных данных",
  oauth: {
    sectionTitle: "Подписка / OAuth-планы",
    sectionHint:
      "Войдите по подписке провайдера вместо API-ключа. Авторизация происходит в браузере.",
    signIn: "Войти",
    runningHint: "Выполните шаги ниже, чтобы завершить вход.",
    successHint: "Вход выполнен. Теперь можно выбрать этого провайдера.",
    failed: "Не удалось войти.",
    codexDesc: "Используйте свой план ChatGPT Codex",
    xaiDesc: "Используйте свою подписку xAI Grok",
    qwenDesc: "Используйте свою подписку Qwen",
    geminiDesc: "Используйте свой план Google AI Pro / Gemini",
    minimaxDesc: "Используйте свою подписку MiniMax",
    nousDesc: "Войдите через подписку Nous Portal",
  },
} as const;
