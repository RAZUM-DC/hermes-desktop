/**
 * Переключение вкладок: три механизма с разными списками.
 *
 * Цифры и стрелки работают по верхней строке — по тому же порядку, который
 * человек видит на экране, и по всем вкладкам сразу: и диалогам, и разделам.
 * Ctrl+Tab работает по сайдбару, то есть по недавним диалогам вообще, включая
 * ещё не открытые: это уже не переключение вкладок, а переход в историю, и он
 * может стоить загрузки переписки, поэтому разделов там нет.
 *
 * Долгое время эта шапка была неправдой: разделы появились в верхней строке
 * позже стрелок, а список для них строился из одних диалогов — стрелки ходили
 * мимо половины того, что человек видел.
 */

/** Сколько диалогов показываем в панели Ctrl+Tab. */
export const SWITCHER_LIMIT = 10;

/** Сколько вкладок доступно по Ctrl+цифра. Дальше — только стрелками. */
export const MAX_POSITION = 9;

export interface SwitcherItem {
  /** Идентификатор сессии (сайдбар оперирует ими, а не вкладками). */
  id: string;
  title: string;
}

export interface SwitcherState {
  items: SwitcherItem[];
  index: number;
}

/**
 * Порядок вкладок в верхней строке: сначала диалоги, потом разделы.
 *
 * Ровно тот же порядок, в каком их рисует ActiveSessionsBar. Список собирается
 * здесь, а не в компоненте, чтобы у переключателя и у полосы он не разъехался:
 * стрелка, уводящая не туда, куда показывает глаз, хуже отсутствующей.
 */
export function tabOrder(
  runIds: readonly string[],
  sectionViews: readonly string[],
): string[] {
  return [...runIds, ...sectionViews];
}

/**
 * Вкладка по номеру в верхней строке. Нумерация буквальная: первая вкладка —
 * это `Ctrl+1`, девятая — `Ctrl+9`, десятой и дальше по цифрам не добраться.
 */
export function runIdAtPosition(
  runIds: readonly string[],
  position: number,
): string | null {
  if (position < 1 || position > MAX_POSITION) return null;
  return runIds[position - 1] ?? null;
}

/**
 * Соседняя вкладка по порядку строки, с зацикливанием: после последней идёт
 * первая, перед первой — последняя.
 */
export function neighbourRunId(
  runIds: readonly string[],
  activeId: string,
  backwards = false,
): string | null {
  if (runIds.length === 0) return null;
  const current = runIds.indexOf(activeId);
  if (current === -1) return runIds[0];
  const next = (current + (backwards ? -1 : 1) + runIds.length) % runIds.length;
  return runIds[next];
}

/**
 * Открывает панель Ctrl+Tab по списку сайдбара.
 *
 * Начинаем со следующего за текущим — как у Alt+Tab, одно нажатие без
 * удержания ведёт к соседнему диалогу, а не оставляет на месте.
 */
export function openSwitcher(
  items: readonly SwitcherItem[],
  currentSessionId: string | null,
  backwards = false,
  limit = SWITCHER_LIMIT,
): SwitcherState | null {
  const list = items.slice(0, limit);
  if (list.length < 2) return null;
  const current = currentSessionId
    ? list.findIndex((i) => i.id === currentSessionId)
    : -1;
  const start =
    current === -1
      ? backwards
        ? list.length - 1
        : 0
      : (current + (backwards ? -1 : 1) + list.length) % list.length;
  return { items: list, index: start };
}

/** Следующий шаг цикла в панели. */
export function advance(
  state: SwitcherState,
  backwards = false,
): SwitcherState {
  const size = state.items.length;
  const index = (state.index + (backwards ? -1 : 1) + size) % size;
  return { ...state, index };
}

/** Подпись диалога в панели. */
export function switcherLabel(item: SwitcherItem, fallback: string): string {
  return item.title.trim() || fallback;
}
