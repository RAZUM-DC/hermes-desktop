/**
 * Временные отказы транспорта между десктопом и дашбордом.
 *
 * Зачем это понадобилось. В гибридном режиме запросы идут через companion,
 * который в момент старта приложения ещё договаривается с релеем. Список
 * чатов запрашивается сразу, попадает в этот промежуток и получает
 *
 *   503: companion: agent session not ready
 *
 * Раньше такой ответ молча проглатывался, и сайдбар до минуты (до следующего
 * тика фонового таймера) показывал «Нет чатов» — неотличимо от настоящей
 * потери истории. На диагностику этого «исчезновения» уходит полчаса, хотя
 * данные всё это время лежат на сервере целыми.
 *
 * Поэтому: отличаем «ещё не готов» от «пусто» и повторяем запрос несколько
 * раз с нарастающей паузой. Повторяем только то, что заведомо безопасно
 * повторять, и только пока отказ выглядит временным.
 */

/** Задержки между попытками, мс. Сумма ≈ 9 с — столько companion поднимается. */
export const RETRY_DELAYS_MS = [300, 700, 1500, 2500, 4000] as const;

/**
 * Похож ли отказ на «ещё не готов», а не на «сломано» или «нельзя».
 *
 * Сознательно узкий список. 403 сюда не входит: это отказ в правах, он от
 * повторов не пройдёт, и долбить им шим бессмысленно. 4xx вообще не входят —
 * повторять запрос, который сервер счёл неправильным, бесполезно.
 */
export function isTransientUpstream(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (!message) return false;
  return (
    // Ответ шима, пока сессия с релеем не установлена.
    /\bagent session not ready\b/i.test(message) ||
    // Шим поднялся, но апстрим ещё не отвечает.
    /^503\b/.test(message) ||
    /^502\b/.test(message) ||
    /^504\b/.test(message) ||
    // Порт ещё не слушает: companion стартует чуть позже главного процесса.
    /\bECONNREFUSED\b/.test(message) ||
    /\bECONNRESET\b/.test(message) ||
    /\bsocket hang up\b/i.test(message)
  );
}

/**
 * Выполняет `attempt`, повторяя его, пока отказ выглядит временным.
 *
 * Последняя ошибка пробрасывается наружу как есть: если companion так и не
 * поднялся, вызывающая сторона должна об этом узнать и сказать человеку
 * «не удалось загрузить», а не изображать пустой список.
 *
 * `sleep` вынесен параметром ради тестов — иначе каждый прогон ждал бы
 * настоящие девять секунд.
 */
export async function retryWhileNotReady<T>(
  attempt: () => Promise<T>,
  delays: readonly number[] = RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= delays.length; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (!isTransientUpstream(error)) throw error;
      if (i === delays.length) break;
      await sleep(delays[i]);
    }
  }
  throw lastError;
}
