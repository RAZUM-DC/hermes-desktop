/**
 * Память об уведомлении «панельный чат недоступен».
 *
 * Плашка полезна ровно один раз: она объясняет, почему часть возможностей
 * урезана. Но проверка транспорта идёт при каждом запуске, и на подключении,
 * где панель не заработает никогда, уведомление превращается в шум. Поэтому
 * запоминаем пару «режим подключения + причина отказа»: тот же отказ на том же
 * подключении молчит, а новый — например, другой шаг проверки или другой
 * режим — показывается снова.
 *
 * Память живёт в localStorage: она про удобство, а не про данные, и потерять
 * её не страшно — в худшем случае человек увидит плашку лишний раз.
 */

export const DASHBOARD_NOTICE_KEY = "hermes.chat.dashboardFallbackNotice";

type NoticeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): NoticeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Отпечаток отказа: одинаковые отпечатки считаются одним и тем же случаем. */
export function noticeSignature(mode: string, reason: string): string {
  return `${mode}\u0000${(reason || "").trim()}`;
}

/**
 * Показывать ли плашку. Побочный эффект намеренный: решение и запоминание —
 * одно действие, иначе две вкладки успеют показать её обе.
 */
export function claimFallbackNotice(
  signature: string,
  storage: NoticeStorage | null = defaultStorage(),
): boolean {
  if (!storage) return true;
  try {
    if (storage.getItem(DASHBOARD_NOTICE_KEY) === signature) return false;
    storage.setItem(DASHBOARD_NOTICE_KEY, signature);
    return true;
  } catch {
    // Хранилище недоступно — лучше показать лишний раз, чем промолчать.
    return true;
  }
}

/** Сбрасывает память: настройки подключения изменились, случай уже другой. */
export function forgetFallbackNotice(
  storage: NoticeStorage | null = defaultStorage(),
): void {
  try {
    storage?.removeItem(DASHBOARD_NOTICE_KEY);
  } catch {
    /* ignore */
  }
}
