import type { Note } from "../../../../shared/notes";

/** Сколько символов текста влезает в плитку, прежде чем её обрывает многоточие. */
export const EXCERPT_LIMIT = 180;

/**
 * Что писать на плитке в качестве заголовка.
 *
 * Автоматическое название собирается здесь, а не в хранилище, потому что оно
 * зависит от языка интерфейса: в файле лежит только номер. Иначе заметки,
 * заведённые до переключения языка, остались бы подписаны по-русски посреди
 * английского меню.
 */
export function noteTitle(
  note: Pick<Note, "title" | "autoNumber">,
  autoLabel: (n: number) => string,
): string {
  const own = note.title.trim();
  if (own) return own;
  return autoLabel(note.autoNumber > 0 ? note.autoNumber : 1);
}

/**
 * Кусок текста для плитки: одной строкой, без лишних пробелов и переносов.
 *
 * Переносы схлопываются нарочно. В заметке они несут смысл, но на плитке в
 * три строки высоты пустая строка между абзацами съела бы треть того, что
 * человек мог бы прочитать, не открывая её.
 */
export function noteExcerpt(text: string, limit = EXCERPT_LIMIT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  // Режем по границе слова, чтобы не обрывать на половине.
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${space > limit * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * Что из заметки уезжает в поле ввода диалога.
 *
 * Автоматическое название не берётся намеренно. «Заметка 3» ничего не говорит
 * ни человеку, ни ассистенту — это ярлык для плитки, а не часть содержимого, и
 * первой строкой сообщения он был бы просто шумом. Заголовок, который человек
 * написал сам, наоборот, несёт смысл и едет вместе с текстом.
 */
export function noteForChat(note: Pick<Note, "title" | "text">): string {
  const title = note.title.trim();
  const text = note.text.trim();
  if (!title) return text;
  return text ? `${title}\n${text}` : title;
}
