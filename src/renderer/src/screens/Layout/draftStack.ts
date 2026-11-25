/**
 * Отстойник черновиков: снимки экрана и голосовые заметки ждут здесь, пока
 * человек выберет диалог.
 *
 * Оба типа лежат в одном списке намеренно. Смысл у них общий — «сделанное
 * ждёт адресата», — а две карточки в одном углу дрались бы за место и за
 * внимание. Различаются они только тем, как выглядят в строке и что делает
 * вставка: снимок цепляется вложением, текст дописывается в поле ввода.
 *
 * Логика вынесена из компонента из-за освобождения object URL: каждый снимок
 * держит ссылку на блоб, и если её не отозвать при удалении, картинка
 * останется в памяти рендерера до перезагрузки окна. Все пути (удаление,
 * вытеснение из стека, очистка) сходятся здесь и покрыты тестами.
 */

/**
 * Сколько черновиков держим. Дальше самый старый вытесняется.
 *
 * Пяти хватало, пока сюда попадали только снимки и диктовка — по одному за
 * раз. Заметка приезжает целиком: текстом и каждым вложением отдельной
 * строкой, и заметка с четырьмя файлами вытеснила бы из карточки всё
 * остальное, включая собственный текст.
 */
export const STACK_LIMIT = 10;

interface DraftBase {
  id: string;
  /** Когда появился — для подписи в строке. */
  at: number;
  /** Вставка начата, но чат её ещё не подтвердил. */
  inserting?: boolean;
}

export interface ImageDraft extends DraftBase {
  kind: "image";
  /** Имя файла — оно же уедет во вложение. */
  name: string;
  /** Блоб-ссылка для миниатюры и полноразмерного просмотра. */
  url: string;
  file: File;
}

/**
 * Файл, который не картинка: вложение заметки — договор, таблица, что угодно.
 *
 * Отдельный вид, а не ImageDraft без `url`: миниатюры у него нет и быть не
 * может, а необязательное поле заставило бы каждое место, которое рисует
 * картинку, проверять, есть ли она на самом деле.
 */
export interface FileDraft extends DraftBase {
  kind: "file";
  name: string;
  file: File;
}

export interface TextDraft extends DraftBase {
  kind: "text";
  text: string;
  /**
   * `recognizing` — запись окончена, текста ещё нет;
   * `empty` — распознавание не дало ничего;
   * `ready` — можно вставлять.
   */
  state: "recognizing" | "ready" | "empty";
}

export type PendingDraft = ImageDraft | FileDraft | TextDraft;

/** Освобождение блоб-ссылки. Вынесено ради тестов: в jsdom его нет. */
type Revoke = (url: string) => void;

const defaultRevoke: Revoke = (url) => {
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* ignore: окно могло уже закрыться */
  }
};

function release(draft: PendingDraft, revoke: Revoke): void {
  if (draft.kind === "image") revoke(draft.url);
}

/** Готов ли черновик к вставке: у заметки текст мог ещё не приехать. */
export function isInsertable(draft: PendingDraft): boolean {
  if (draft.inserting) return false;
  if (draft.kind === "image" || draft.kind === "file") return true;
  return draft.state === "ready";
}

/**
 * Ждём ли мы сейчас текст от распознавания.
 *
 * Нужно полю ввода: между отпусканием клавиш и приходом текста проходит от
 * доли секунды до нескольких (в первый раз модель ещё поднимается с диска), и
 * всё это время человек смотрит в пустую строку с курсором. Пустая строка
 * читается как «ничего не записалось», поэтому на это время поле подменяет
 * подсказку.
 *
 * Флаг именно производный от стека черновиков, а не отдельное состояние:
 * иначе он разъедется с карточкой — например, если диктовку отменили и строку
 * убрали, а флаг снять забыли, поле останется с чужой подсказкой навсегда.
 */
export function isRecognizing(stack: readonly PendingDraft[]): boolean {
  return stack.some((d) => d.kind === "text" && d.state === "recognizing");
}

/**
 * Кладёт новый черновик наверх. Стек ограничен: вытесненный освобождает свою
 * ссылку здесь же, иначе память утечёт незаметно.
 */
export function pushDraft(
  stack: readonly PendingDraft[],
  draft: PendingDraft,
  limit = STACK_LIMIT,
  revoke: Revoke = defaultRevoke,
): PendingDraft[] {
  const next = [draft, ...stack];
  for (const dropped of next.slice(limit)) release(dropped, revoke);
  return next.slice(0, limit);
}

export function removeDraft(
  stack: readonly PendingDraft[],
  id: string,
  revoke: Revoke = defaultRevoke,
): PendingDraft[] {
  const target = stack.find((d) => d.id === id);
  if (!target) return stack as PendingDraft[];
  release(target, revoke);
  return stack.filter((d) => d.id !== id);
}

export function clearDrafts(
  stack: readonly PendingDraft[],
  revoke: Revoke = defaultRevoke,
): PendingDraft[] {
  for (const draft of stack) release(draft, revoke);
  return [];
}

/** Помечает черновик как отправленный в чат, ничего не удаляя. */
export function markInserting(
  stack: readonly PendingDraft[],
  id: string,
  inserting: boolean,
): PendingDraft[] {
  return stack.map((d) => (d.id === id ? { ...d, inserting } : d));
}

/**
 * Достраивает заметку распознанным текстом. Пустой результат — не ошибка, но
 * и вставлять там нечего, поэтому строка остаётся с пометкой: человек должен
 * понять, что запись не потерялась, а именно не распозналась.
 */
export function resolveTextDraft(
  stack: readonly PendingDraft[],
  id: string,
  text: string,
): PendingDraft[] {
  const clean = (text || "").trim();
  return stack.map((d) =>
    d.id === id && d.kind === "text"
      ? { ...d, text: clean, state: clean ? "ready" : "empty" }
      : d,
  );
}

/** Подпись в строке: время появления, дата тут не нужна. */
export function draftLabel(draft: PendingDraft, locale: string): string {
  return new Date(draft.at).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
