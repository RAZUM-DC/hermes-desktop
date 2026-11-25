/**
 * Доступна ли выбранная папка агенту.
 *
 * В гибридном режиме агент живёт на сервере и до файлов на компьютере
 * дотягивается единственным способом — через инструменты `local.*` у
 * tool-connector. А у того список корней задан жёстко при запуске:
 *
 *   tool-connector v0.1.0 starting; roots=[C:\Users\...\Documents
 *                                          C:\Users\...\Downloads
 *                                          C:\Users\...\Desktop]
 *
 * Папку вне этих корней агент просто не увидит — и узнать об этом человек
 * сейчас может только по невнятному ответу через минуту после вопроса.
 * Поэтому проверяем сразу при выборе и говорим прямо.
 *
 * Сравнение здесь не такое очевидное, как кажется, оттого и вынесено
 * отдельно: на Windows регистр не важен, разделители встречаются оба, а
 * проверка «начинается с» без учёта границы сегмента считает `Documents2`
 * лежащим внутри `Documents`.
 */

/** Приводит путь к виду, пригодному для сравнения. */
function canonical(path: string): string {
  return path
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Лежит ли `path` внутри одного из `roots` (или совпадает с ним). */
export function isInsideRoots(path: string, roots: readonly string[]): boolean {
  const target = canonical(path);
  if (!target) return false;
  return roots.some((root) => {
    const base = canonical(root);
    if (!base) return false;
    if (target === base) return true;
    // Граница сегмента обязательна: иначе «…/Documents2» сойдёт за «…/Documents».
    return target.startsWith(`${base}/`);
  });
}
