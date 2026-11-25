import { useI18n } from "../../components/useI18n";
import { switcherLabel, type SwitcherState } from "./runSwitcher";

interface ChatSwitcherOverlayProps {
  state: SwitcherState;
}

/**
 * Панель переключения диалогов — то, что видно, пока зажата комбинация.
 *
 * Это наложение внутри окна, а не отдельное окно: фокус остаётся в поле
 * ввода, и после отпускания клавиш можно сразу продолжать печатать.
 *
 * Номеров у строк нет намеренно. Список берётся из сайдбара, а цифровые
 * комбинации нумеруют вкладки верхней строки — это разные порядки, и
 * нумерация здесь подсказывала бы несуществующую связь.
 */
export function ChatSwitcherOverlay({
  state,
}: ChatSwitcherOverlayProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="run-switcher-backdrop">
      <div
        className="run-switcher"
        role="listbox"
        aria-label={t("navigation.chats")}
      >
        {state.items.map((item, i) => (
          <div
            key={item.id}
            className={`run-switcher-item${i === state.index ? " active" : ""}`}
            role="option"
            aria-selected={i === state.index}
          >
            <span className="run-switcher-title">
              {switcherLabel(item, t("sessions.newConversation"))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
