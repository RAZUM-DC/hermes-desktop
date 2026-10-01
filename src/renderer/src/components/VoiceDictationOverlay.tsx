import { useCallback, useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { useI18n } from "./useI18n";

/**
 * Окошко быстрой диктовки.
 *
 * Живёт в отдельном окне (маршрут `#voice-overlay`), которое main показывает
 * по глобальной горячей клавише. Запись идёт, пока зажата комбинация: main
 * умеет отдать только нажатие, поэтому отпускание ловит это окно — оно
 * всплывает сфокусированным, и keyup внутри него приходит как обычное
 * событие. Если человек отпустил клавиши раньше, чем окно получило фокус,
 * keyup не придёт: тогда запись завершает повторное нажатие хоткея (main
 * присылает `finish`), Escape или потеря фокуса.
 */

/** Как часто просить промежуточную расшифровку, мс. */
const PARTIAL_INTERVAL_MS = 1500;
/** Страховка: запись не может идти вечно, даже если про неё забыли. */
const MAX_RECORDING_MS = 60_000;
/**
 * Потеря фокуса завершает запись — но не сразу после показа окна: пока оно
 * поднимается, blur может прилететь от окна, которое фокус уступает.
 */
const BLUR_GRACE_MS = 800;
/**
 * Сколько не верить отпусканию клавиш после начала записи.
 *
 * Перехватывая глобальную комбинацию, Windows отпускает модификаторы за
 * пользователя — новое окно почти сразу получает keyup на Control и Alt,
 * хотя человек их держит. Без этой паузы запись обрывалась бы мгновенно.
 * Цена — очень короткое нажатие не будет распознано как удержание; тогда
 * работает откат на переключатель (повторное нажатие хоткея или Escape).
 */
const KEYUP_GRACE_MS = 700;

type Phase = "idle" | "recording" | "transcribing" | "done" | "error";

/** Сколько показывать «готово, ждёт в приложении» перед закрытием, мс. */
const DONE_HOLD_MS = 1600;

export function VoiceDictationOverlay(): React.JSX.Element {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("idle");
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);

  const keysRef = useRef<string[]>([]);
  const codesRef = useRef<string[]>([]);
  // За отпусканием следит сайдкар. Пока это так, событиям клавиатуры верить
  // нельзя: перехватывая комбинацию, Windows шлёт окну «отпускания»
  // модификаторов, которых не было. Клавиатурный путь остаётся только на
  // случай, когда наблюдателя нет.
  const holdWatchRef = useRef(false);
  // Тихая диктовка: окно приложения не поднимается, поэтому сказать, что
  // заметка готова, больше негде — это делает само окошко.
  const quietRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const capRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef(0);
  // Запись завершается ровно один раз: keyup, повторный хоткей, blur и
  // страховочный таймер могут сработать почти одновременно.
  const finishingRef = useRef(false);
  const recordingRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (capRef.current) {
      clearTimeout(capRef.current);
      capRef.current = null;
    }
  }, []);

  const finish = useCallback(async () => {
    console.log(
      `[dictation] finish requested (recording=${recordingRef.current}, finishing=${finishingRef.current})`,
    );
    if (!recordingRef.current || finishingRef.current) return;
    finishingRef.current = true;
    recordingRef.current = false;
    clearTimers();
    // В обычном режиме основное окно поднимается сразу: ждать распознавания
    // человек должен уже в приложении, а не перед плашкой. В тихом — окно не
    // трогаем, и договариваем всё сами.
    void window.hermesAPI.beginDictationHandoff?.().catch(() => undefined);

    // Тихая плашка про ход работы не рассказывает. Она для того и тихая,
    // чтобы не задерживать: сразу говорит, чем дело кончится, и уходит, а
    // распознавание доезжает уже в карточку приложения.
    const quiet = quietRef.current;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    if (quiet) {
      setPhase("done");
      closeTimer = setTimeout(
        () => void window.hermesAPI.closeDictation?.(),
        DONE_HOLD_MS,
      );
    } else {
      setPhase("transcribing");
    }

    try {
      const text = await window.hermesAPI.stopVoiceRecording();
      console.log(`[dictation] transcript characters: ${(text || "").length}`);
      await window.hermesAPI.commitDictation(text || "");
      setPartial("");
      // Плашка тихого режима уже сказала своё и закрывается по таймеру.
      if (quiet) return;
      setPhase("idle");
    } catch (e) {
      // Ошибку нужно показать, а не спрятать: отменяем закрытие по таймеру.
      if (closeTimer) clearTimeout(closeTimer);
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
      // Плашка уже скрыта — возвращаем её, чтобы ошибку было где прочитать.
      void window.hermesAPI.showDictationError?.().catch(() => undefined);
      // И убираем сама: висеть поверх всех окон с ошибкой она не должна.
      setTimeout(() => void window.hermesAPI.cancelDictation(), 2500);
    } finally {
      finishingRef.current = false;
    }
  }, [clearTimers]);

  const cancel = useCallback(async () => {
    recordingRef.current = false;
    finishingRef.current = false;
    holdWatchRef.current = false;
    clearTimers();
    setPhase("idle");
    setPartial("");
    try {
      await window.hermesAPI.cancelVoiceRecording();
    } catch {
      /* запись могла и не начаться */
    }
    await window.hermesAPI.cancelDictation();
  }, [clearTimers]);

  const begin = useCallback(
    async (keys: string[], codes: string[], quiet: boolean) => {
      keysRef.current = keys;
      codesRef.current = codes;
      quietRef.current = quiet;
      finishingRef.current = false;
      setError(null);
      setPartial("");
      setPhase("recording");
      try {
        const language = (navigator.language || "ru").split("-")[0];
        await window.hermesAPI.startVoiceRecording(language);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
        setTimeout(() => void window.hermesAPI.cancelDictation(), 2500);
        return;
      }
      recordingRef.current = true;
      startedAtRef.current = Date.now();
      console.log("[dictation] recording started");
      // Удержание комбинации: система перехватывает глобальный хоткей целиком,
      // поэтому отпускание за нас ловит сайдкар, опрашивая состояние клавиш.
      // Ответ приезжает событием «завершить»; если зажать не успели, ответа
      // не будет вовсе и останется режим переключателя.
      holdWatchRef.current =
        typeof window.hermesAPI.watchDictationHold === "function";
      void window.hermesAPI
        .watchDictationHold?.()
        .then((result) => {
          if (result === null) holdWatchRef.current = false;
        })
        .catch(() => {
          holdWatchRef.current = false;
        });
      timerRef.current = setInterval(() => {
        void window.hermesAPI
          .partialVoiceTranscript()
          .then((text) => {
            if (recordingRef.current && text) setPartial(text);
          })
          .catch(() => undefined);
      }, PARTIAL_INTERVAL_MS);
      capRef.current = setTimeout(() => void finish(), MAX_RECORDING_MS);
    },
    [finish],
  );

  useEffect(() => {
    const offBegin = window.hermesAPI.onDictationBegin((info) => {
      void begin(info.keys || [], info.codes || [], !!info.quiet);
    });
    const offFinish = window.hermesAPI.onDictationFinish(() => {
      console.log("[dictation] finish event received");
      void finish();
    });
    return () => {
      offBegin();
      offFinish();
    };
  }, [begin, finish]);

  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!recordingRef.current || holdWatchRef.current) return;
      if (Date.now() - startedAtRef.current < KEYUP_GRACE_MS) return;
      const released = String(event.key).toLowerCase();
      const byKey = keysRef.current.some((k) => k.toLowerCase() === released);
      const byCode = codesRef.current.includes(event.code);
      if (byKey || byCode) void finish();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") void cancel();
    };
    const onBlur = (): void => {
      if (!recordingRef.current) return;
      if (Date.now() - startedAtRef.current < BLUR_GRACE_MS) return;
      void finish();
    };
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [cancel, finish]);

  const title =
    phase === "transcribing"
      ? t("chat.voiceTranscribing")
      : phase === "done"
        ? t("chat.dictationWaiting")
        : phase === "error"
          ? t("chat.voiceFailed", { detail: error || "" })
          : t("chat.dictationListening", { defaultValue: "Говорите…" });

  return (
    <div className={`dictation-overlay dictation-overlay--${phase}`}>
      <div className="dictation-overlay-row">
        <span className="dictation-overlay-mic" aria-hidden="true">
          <Mic size={18} />
        </span>
        <span className="dictation-overlay-title">{title}</span>
      </div>
      <div className="dictation-overlay-text">
        {phase === "done"
          ? t("chat.dictationWaitingHint")
          : partial ||
            (phase === "recording"
              ? t("chat.dictationHint", {
                  defaultValue: "Release the keys to insert the text",
                })
              : "")}
      </div>
    </div>
  );
}
