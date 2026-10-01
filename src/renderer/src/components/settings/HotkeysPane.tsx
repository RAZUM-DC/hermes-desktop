import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard } from "lucide-react";
import { useI18n } from "../useI18n";
import {
  acceleratorFromEvent,
  formatAccelerator,
  INSERT_DRAFT_DEFAULT,
  isInAppAction,
  NEXT_CHAT_DEFAULT,
  PREV_CHAT_DEFAULT,
  REGION_DEFAULT,
  SCREENSHOT_DEFAULT,
  SWITCH_CHAT_DEFAULT,
  VOICE_DICTATION_DEFAULT,
  VOICE_DICTATION_QUIET_DEFAULT,
  type HotkeyAction,
} from "../../../../shared/hotkeys";

type Status =
  | { kind: "idle" }
  | { kind: "recording"; action: HotkeyAction }
  | { kind: "ok"; action: HotkeyAction; accelerator: string }
  | { kind: "error"; action: HotkeyAction; problem: string };

/**
 * Глобальные комбинации перехватывает система — их занятость проверяется
 * попыткой регистрации. Внутриоконные система не видит вовсе: они работают
 * только когда окно в фокусе и конфликтовать могут лишь с нашими же.
 */
type Scope = "global" | "inApp";

const ACTIONS: ReadonlyArray<{
  id: HotkeyAction;
  scope: Scope;
  labelKey: string;
  hintKey: string;
  fallback: string;
}> = [
  {
    id: "voiceDictation",
    scope: "global",
    labelKey: "settings.hotkeys.voiceDictation",
    hintKey: "settings.hotkeys.voiceDictationHint",
    fallback: VOICE_DICTATION_DEFAULT,
  },
  {
    id: "voiceDictationQuiet",
    scope: "global",
    labelKey: "settings.hotkeys.voiceDictationQuiet",
    hintKey: "settings.hotkeys.voiceDictationQuietHint",
    fallback: VOICE_DICTATION_QUIET_DEFAULT,
  },
  {
    id: "screenshot",
    scope: "global",
    labelKey: "settings.hotkeys.screenshot",
    hintKey: "settings.hotkeys.screenshotHint",
    fallback: SCREENSHOT_DEFAULT,
  },
  {
    id: "region",
    scope: "global",
    labelKey: "settings.hotkeys.region",
    hintKey: "settings.hotkeys.regionHint",
    fallback: REGION_DEFAULT,
  },
  {
    id: "switchChat",
    scope: "inApp",
    labelKey: "settings.hotkeys.switchChat",
    hintKey: "settings.hotkeys.switchChatHint",
    fallback: SWITCH_CHAT_DEFAULT,
  },
  {
    id: "nextChat",
    scope: "inApp",
    labelKey: "settings.hotkeys.nextChat",
    hintKey: "settings.hotkeys.nextChatHint",
    fallback: NEXT_CHAT_DEFAULT,
  },
  {
    id: "prevChat",
    scope: "inApp",
    labelKey: "settings.hotkeys.prevChat",
    hintKey: "settings.hotkeys.prevChatHint",
    fallback: PREV_CHAT_DEFAULT,
  },
  {
    id: "insertDraft",
    scope: "inApp",
    labelKey: "settings.hotkeys.insertDraft",
    hintKey: "settings.hotkeys.insertDraftHint",
    fallback: INSERT_DRAFT_DEFAULT,
  },
];

const SCOPES: ReadonlyArray<{ id: Scope; labelKey: string }> = [
  { id: "global", labelKey: "settings.hotkeys.groups.global" },
  { id: "inApp", labelKey: "settings.hotkeys.groups.inApp" },
];

/**
 * Горячие клавиши.
 *
 * Поля работают как записывающие: нажатие не набирает текст, а запоминается
 * целиком. Перед сохранением комбинация проверяется — и по форме, и на
 * занятость: главный процесс пробует её зарегистрировать, потому что иначе
 * узнать, свободна ли она в системе, нельзя.
 */
export default function HotkeysPane(): React.JSX.Element {
  const { t } = useI18n();
  const [hotkeys, setHotkeys] = useState<Record<HotkeyAction, string>>({
    voiceDictation: VOICE_DICTATION_DEFAULT,
    screenshot: SCREENSHOT_DEFAULT,
    region: REGION_DEFAULT,
    switchChat: SWITCH_CHAT_DEFAULT,
    nextChat: NEXT_CHAT_DEFAULT,
    prevChat: PREV_CHAT_DEFAULT,
    insertDraft: INSERT_DRAFT_DEFAULT,
    voiceDictationQuiet: VOICE_DICTATION_QUIET_DEFAULT,
  });
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const fieldRefs = useRef<Partial<Record<HotkeyAction, HTMLButtonElement>>>(
    {},
  );

  useEffect(() => {
    let alive = true;
    void window.hermesAPI
      .getHotkeys?.()
      .then((h) => {
        if (!alive || !h) return;
        setHotkeys({
          voiceDictation: h.voiceDictation || VOICE_DICTATION_DEFAULT,
          screenshot: h.screenshot || SCREENSHOT_DEFAULT,
          region: h.region || REGION_DEFAULT,
          switchChat: h.switchChat || SWITCH_CHAT_DEFAULT,
          nextChat: h.nextChat || NEXT_CHAT_DEFAULT,
          prevChat: h.prevChat || PREV_CHAT_DEFAULT,
          insertDraft: h.insertDraft || INSERT_DRAFT_DEFAULT,
          voiceDictationQuiet:
            h.voiceDictationQuiet || VOICE_DICTATION_QUIET_DEFAULT,
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const apply = useCallback(
    async (action: HotkeyAction, accelerator: string) => {
      const save = (): Promise<{ ok: boolean; problem?: string }> => {
        if (isInAppAction(action)) {
          return window.hermesAPI.setInAppHotkey(action, accelerator);
        }
        if (action === "voiceDictation") {
          return window.hermesAPI.setVoiceHotkey(accelerator);
        }
        if (action === "voiceDictationQuiet") {
          return window.hermesAPI.setVoiceQuietHotkey(accelerator);
        }
        if (action === "screenshot") {
          return window.hermesAPI.setScreenshotHotkey(accelerator);
        }
        return window.hermesAPI.setRegionHotkey(accelerator);
      };
      try {
        const result = await save();
        if (result.ok) {
          setHotkeys((prev) => ({ ...prev, [action]: accelerator }));
          setStatus({ kind: "ok", action, accelerator });
          return;
        }
        setStatus({
          kind: "error",
          action,
          problem: result.problem || "taken",
        });
      } catch {
        setStatus({ kind: "error", action, problem: "taken" });
      }
    },
    [],
  );

  const onKeyDown = useCallback(
    (action: HotkeyAction, event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (status.kind !== "recording" || status.action !== action) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.code === "Escape") {
        setStatus({ kind: "idle" });
        fieldRefs.current[action]?.blur();
        return;
      }
      const accelerator = acceleratorFromEvent({
        code: event.code,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
      });
      // Пока нажаты одни модификаторы, комбинации ещё нет — ждём основную
      // клавишу, а не считаем это ошибкой.
      if (!accelerator) return;
      fieldRefs.current[action]?.blur();
      void apply(action, accelerator);
    },
    [apply, status],
  );

  function messageFor(
    action: HotkeyAction,
  ): { text: string; tone: "ok" | "error" } | null {
    if (status.kind === "ok" && status.action === action) {
      return {
        text: t("settings.hotkeys.saved", {
          hotkey: formatAccelerator(status.accelerator),
        }),
        tone: "ok",
      };
    }
    if (status.kind === "error" && status.action === action) {
      return {
        text: t(`settings.hotkeys.problem.${status.problem}`),
        tone: "error",
      };
    }
    return null;
  }

  return (
    <div className="settings-modal-pane">
      {SCOPES.map((scope) => (
        <div className="settings-hotkey-group" key={scope.id}>
          <div className="settings-hotkey-group-label">{t(scope.labelKey)}</div>
          {ACTIONS.filter((a) => a.scope === scope.id).map((action) => {
            const recording =
              status.kind === "recording" && status.action === action.id;
            const message = messageFor(action.id);
            return (
              <div className="settings-field" key={action.id}>
                <label className="settings-field-label">
                  {t(action.labelKey)}
                </label>
                <button
                  ref={(el) => {
                    if (el) fieldRefs.current[action.id] = el;
                  }}
                  type="button"
                  className={`settings-hotkey-field${recording ? " recording" : ""}`}
                  onClick={() =>
                    setStatus({ kind: "recording", action: action.id })
                  }
                  onBlur={() =>
                    setStatus((s) =>
                      s.kind === "recording" && s.action === action.id
                        ? { kind: "idle" }
                        : s,
                    )
                  }
                  onKeyDown={(event) => onKeyDown(action.id, event)}
                >
                  <Keyboard size={16} />
                  <span>
                    {recording
                      ? t("settings.hotkeys.press")
                      : formatAccelerator(
                          hotkeys[action.id] || action.fallback,
                        )}
                  </span>
                </button>
                <div className="settings-field-hint">{t(action.hintKey)}</div>
                {message && (
                  <div className={`settings-hotkey-message ${message.tone}`}>
                    {message.text}
                  </div>
                )}
              </div>
            );
          })}
          {scope.id === "inApp" && (
            <div className="settings-field-hint">
              {t("settings.hotkeys.positionsHint")}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
