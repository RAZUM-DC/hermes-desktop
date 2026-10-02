/**
 * Прокрутка полосы вкладок колесом мыши.
 *
 * Полоса и так прокручивается — у неё `overflow-x: auto`, — но колесо до неё
 * не доходит: сама полоса объявлена областью перетаскивания окна, и события
 * мыши над пустым местом достаются оконному слою, а не странице. Поэтому
 * колесо обрабатывается явно.
 */

/**
 * Насколько сдвинуть полосу по одному событию колеса.
 *
 * Берём большее из вертикального и горизонтального смещения: у обычной мыши
 * есть только вертикальное, у трекпада чаще горизонтальное, и человек в обоих
 * случаях ждёт, что вкладки поедут вбок.
 *
 * Смещение приходит в разных единицах: ноль — пиксели, единица — строки,
 * двойка — страницы. Браузер подставляет строки для многих мышей, и без
 * пересчёта полоса ползла бы по три пикселя за щелчок.
 */
export const LINE_HEIGHT_PX = 40;
export const PAGE_WIDTH_PX = 320;

export function wheelScrollDelta(
  deltaY: number,
  deltaX: number,
  deltaMode = 0,
): number {
  const raw = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
  if (deltaMode === 1) return raw * LINE_HEIGHT_PX;
  if (deltaMode === 2) return raw * PAGE_WIDTH_PX;
  return raw;
}

/**
 * Есть ли куда прокручивать.
 *
 * Если вкладки помещаются целиком, событие колеса лучше не перехватывать: над
 * полосой оно тогда ничего не делает, и пусть достаётся тому, кому
 * предназначалось.
 */
export function canScroll(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth - clientWidth > 1;
}

/**
 * Куда прокрутить, чтобы вкладка оказалась видна целиком.
 *
 * Возвращает null, когда она и так видна: лишняя прокрутка на каждое
 * переключение дёргала бы полосу под рукой без всякой причины.
 */
export function scrollToReveal(
  tabLeft: number,
  tabWidth: number,
  scrollLeft: number,
  clientWidth: number,
  margin = 24,
): number | null {
  const left = tabLeft - margin;
  const right = tabLeft + tabWidth + margin;
  if (left < scrollLeft) return Math.max(0, left);
  if (right > scrollLeft + clientWidth) return right - clientWidth;
  return null;
}
