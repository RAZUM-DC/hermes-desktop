import { memo } from "react";
import { Search, Clock, Mail, Code, ChartLine, Bell } from "lucide-react";
import { useI18n } from "../../components/useI18n";

interface Suggestion {
  i18nKey: string;
  text: string;
  Icon: typeof Search;
}

const SUGGESTIONS: Suggestion[] = [
  {
    i18nKey: "chat.suggestionSearch",
    text: "Search the web for today's top tech news",
    Icon: Search,
  },
  {
    i18nKey: "chat.suggestionReminder",
    text: "Set a reminder to check emails every day at 9 AM",
    Icon: Bell,
  },
  {
    i18nKey: "chat.suggestionEmail",
    text: "Read my latest emails and summarize them",
    Icon: Mail,
  },
  {
    i18nKey: "chat.suggestionScript",
    text: "Write a Python script to rename all files in a folder",
    Icon: Code,
  },
  {
    i18nKey: "chat.suggestionSchedule",
    text: "Schedule a cron job to back up my database every night",
    Icon: Clock,
  },
  {
    i18nKey: "chat.suggestionAnalyze",
    text: "Analyze this CSV file and show key insights",
    Icon: ChartLine,
  },
];

interface ChatEmptyStateProps {
  onSelectSuggestion: (text: string) => void;
}

export const ChatEmptyState = memo(function ChatEmptyState({
  onSelectSuggestion,
}: ChatEmptyStateProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="chat-empty">
      {/* Inline SVG avoids passing the bundled data URL through CSS url(),
          where characters in the path can invalidate the mask declaration. */}
      <svg
        className="chat-empty-logo"
        role="img"
        aria-label="РАЗУМ"
        viewBox="0 0 435 528"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g transform="translate(0,528) scale(0.1,-0.1)" fill="currentColor">
          <path d="M1730 5178 c-6 -13 -269 -655 -584 -1428 l-574 -1405 421 -3 c231 -1 424 1 428 5 4 5 174 415 378 913 203 498 373 905 376 905 4 0 172 -405 373 -900 202 -495 371 -906 375 -912 6 -10 103 -13 429 -13 396 0 420 1 414 18 -3 9 -266 653 -583 1430 l-577 1412 -433 0 -433 0 -10 -22z M243 478 l-159 -393 2090 -3 c1149 -1 2091 -1 2092 1 2 2 -69 178 -156 392 -88 215 -160 391 -160 392 0 2 -798 3 -1774 3 l-1773 0 -160 -392z" />
        </g>
      </svg>
      <div className="chat-empty-text">{t("chat.emptyTitle")}</div>
      <div className="chat-empty-hint">{t("chat.emptyHint")}</div>
      <div className="chat-empty-suggestions">
        {SUGGESTIONS.map(({ i18nKey, text, Icon }) => (
          <button
            key={i18nKey}
            className="chat-suggestion"
            onClick={() => onSelectSuggestion(text)}
          >
            <Icon size={16} />
            {t(i18nKey)}
          </button>
        ))}
      </div>
    </div>
  );
});
