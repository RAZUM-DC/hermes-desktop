import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { HermesAvatar, MessageRow } from "./MessageRow";
import { ReasoningRow, ToolActivityGroup } from "./HistoryRow";
import { ClarifyCard } from "./ClarifyCard";
import { useI18n } from "../../components/useI18n";
import type {
  ChatMessage,
  ClarifyMessage,
  ToolCallMessage,
  ToolResultMessage,
} from "./types";

/** Maximum number of trailing transcript rows mounted by default. */
export const TRANSCRIPT_WINDOW = 100;

function isToolRow(m: ChatMessage): m is ToolCallMessage | ToolResultMessage {
  const k = (m as { kind?: string }).kind;
  return k === "tool_call" || k === "tool_result";
}

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  toolProgress: string | null;
  onApprove: () => void;
  onDeny: () => void;
  /** Mark an inline clarify card resolved once the user answers/skips. */
  onClarifyResolved: (requestId: string, answer: string) => void;
}

function TypingIndicator({
  toolProgress,
}: {
  toolProgress: string | null;
}): React.JSX.Element {
  return (
    <div className="chat-message chat-message-agent">
      <HermesAvatar active />
      <div className="chat-bubble chat-bubble-agent">
        {toolProgress ? (
          <div className="chat-tool-progress">{toolProgress}</div>
        ) : (
          <div className="chat-typing">
            <span className="chat-typing-dot" />
            <span className="chat-typing-dot" />
            <span className="chat-typing-dot" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Bubble messages are filtered to "has content". History items (reasoning,
 * tool_call, tool_result) are *always* shown — they're collapsed by default
 * and the user opens them. Filtering them by content would defeat the point.
 */
function isBubble(m: ChatMessage): m is import("./types").ChatBubbleMessage {
  // Bubble messages have no `kind` field (or kind === "user"/"assistant").
  // History items have kind === "reasoning" | "tool_call" | "tool_result".
  const k = (m as { kind?: string }).kind;
  return !k || k === "user" || k === "assistant";
}

export const MessageList = memo(function MessageList({
  messages,
  isLoading,
  toolProgress,
  onApprove,
  onDeny,
  onClarifyResolved,
}: MessageListProps): React.JSX.Element {
  const { t } = useI18n();
  const [extraRows, setExtraRows] = useState(0);
  const [readingFromId, setReadingFromId] = useState<string | null>(null);

  // A mounted Chat screen can be reused for another session. Do not carry an
  // expanded history budget into that next conversation.
  const conversationId = messages[0]?.id;
  const [prevConversationId, setPrevConversationId] = useState(conversationId);
  if (conversationId !== prevConversationId) {
    setPrevConversationId(conversationId);
    setExtraRows(0);
    setReadingFromId(null);
  }

  const earlierMarkerRef = useRef<HTMLDivElement | null>(null);
  const scrollAdjustRef = useRef<{
    container: HTMLElement;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const renderedCountRef = useRef(0);
  const windowSnapshotRef = useRef<{ messages: ChatMessage[]; start: number }>({
    messages: [],
    start: 0,
  });

  // Pin the first mounted row while the reader is away from the bottom, so
  // incoming streaming rows cannot make the text being read disappear.
  useEffect(() => {
    const container = earlierMarkerRef.current?.closest(".chat-messages");
    if (!container) return;
    const onScroll = (): void => {
      const atBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight <
        60;
      if (atBottom) {
        setReadingFromId(null);
      } else {
        const snapshot = windowSnapshotRef.current;
        setReadingFromId(
          (previous) =>
            previous ?? snapshot.messages[snapshot.start]?.id ?? null,
        );
      }
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  const expandEarlier = useCallback(() => {
    const container = earlierMarkerRef.current?.closest(
      ".chat-messages",
    ) as HTMLElement | null;
    if (container) {
      scrollAdjustRef.current = {
        container,
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      };
    }
    setExtraRows(renderedCountRef.current);
    const snapshot = windowSnapshotRef.current;
    setReadingFromId(
      snapshot.messages[Math.max(0, snapshot.start - TRANSCRIPT_WINDOW)]?.id ??
        null,
    );
  }, []);

  // Prepending rows must not move the content currently under the pointer.
  useLayoutEffect(() => {
    const adjust = scrollAdjustRef.current;
    if (!adjust) return;
    scrollAdjustRef.current = null;
    const { container, scrollHeight, scrollTop } = adjust;
    container.scrollTop = scrollTop + (container.scrollHeight - scrollHeight);
  }, [extraRows]);

  // Bubbles with empty content are still hidden (live-stream placeholders).
  // History rows pass through unconditionally.
  const visibleMessages = useMemo(
    () =>
      messages.filter((m) => {
        if (!isBubble(m)) return true;
        return !!m.error || ((m.content as string) || "").trim().length > 0;
      }),
    [messages],
  );

  let lastVisibleBubbleIndex = -1;
  for (let i = visibleMessages.length - 1; i >= 0; i--) {
    if (isBubble(visibleMessages[i])) {
      lastVisibleBubbleIndex = i;
      break;
    }
  }
  const lastVisibleBubbleId =
    lastVisibleBubbleIndex >= 0
      ? visibleMessages[lastVisibleBubbleIndex].id
      : undefined;

  // Keep only the newest rows mounted. The boundary is adjusted so the latest
  // bubble, a pending clarification, and a reasonably-sized tool run stay
  // intact and interactive.
  const windowLimit = TRANSCRIPT_WINDOW + extraRows;
  let windowStart = Math.max(0, visibleMessages.length - windowLimit);
  if (lastVisibleBubbleIndex >= 0 && windowStart > lastVisibleBubbleIndex) {
    windowStart = lastVisibleBubbleIndex;
  }
  const nudgeFloor = Math.max(0, windowStart - TRANSCRIPT_WINDOW);
  while (windowStart > nudgeFloor && isToolRow(visibleMessages[windowStart])) {
    windowStart--;
  }
  const readingIndex =
    readingFromId === null
      ? -1
      : visibleMessages.findIndex((message) => message.id === readingFromId);
  if (readingIndex >= 0) windowStart = Math.min(windowStart, readingIndex);
  const pendingClarifyIndex = visibleMessages.findIndex(
    (message) => message.kind === "clarify" && !message.resolved,
  );
  if (pendingClarifyIndex >= 0) {
    windowStart = Math.min(windowStart, pendingClarifyIndex);
  }
  const hiddenCount = windowStart;
  const windowedMessages =
    windowStart > 0 ? visibleMessages.slice(windowStart) : visibleMessages;
  renderedCountRef.current = windowedMessages.length;
  windowSnapshotRef.current = { messages: visibleMessages, start: windowStart };

  const hiddenMessageCount = useMemo(() => {
    let count = 0;
    for (let i = 0; i < windowStart; i++) {
      if (isBubble(visibleMessages[i])) count++;
    }
    return count;
  }, [visibleMessages, windowStart]);

  const hasEarlier = hiddenCount > 0;
  useEffect(() => {
    const marker = earlierMarkerRef.current;
    if (!marker || !hasEarlier || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) expandEarlier();
      },
      {
        root: marker.closest(".chat-messages"),
        rootMargin: "300px 0px 0px 0px",
      },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [hasEarlier, extraRows, expandEarlier]);

  const beforeWindow =
    windowStart > 0 ? visibleMessages[windowStart - 1] : undefined;

  let lastBubble: ChatMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isBubble(messages[i])) {
      lastBubble = messages[i];
      break;
    }
  }
  const lastMessageIsAgent = !!lastBubble && lastBubble.role === "agent";

  // Render plan: bubble/reasoning rows pass through one-to-one, but a
  // contiguous run of tool_call/tool_result rows folds into a single
  // ToolActivityGroup (collapsed by default) instead of one bubble per call.
  const rows: React.JSX.Element[] = [];
  for (let i = 0; i < windowedMessages.length; i++) {
    const msg = windowedMessages[i];
    // One avatar per turn: show it only on the first row of a contiguous run
    // of same-role rows. The agent turn's thinking/tool rows + answer bubble
    // share one avatar; the continuation rows render a spacer.
    const prev = i === 0 ? beforeWindow : windowedMessages[i - 1];
    const showAvatar = !prev || prev.role !== msg.role;

    if (isToolRow(msg)) {
      // Collect the whole run of consecutive tool rows.
      const group: (ToolCallMessage | ToolResultMessage)[] = [];
      const start = i;
      while (i < windowedMessages.length && isToolRow(windowedMessages[i])) {
        group.push(windowedMessages[i] as ToolCallMessage | ToolResultMessage);
        i++;
      }
      i--; // step back: the for-loop's i++ advances past the run
      const groupPrev =
        start === 0 ? beforeWindow : windowedMessages[start - 1];
      rows.push(
        <ToolActivityGroup
          key={`${group[0].id}-${windowStart + start}`}
          items={group}
          // Active (spinner) only while streaming and this run is trailing.
          active={isLoading && i === windowedMessages.length - 1}
          showAvatar={!groupPrev || groupPrev.role !== "agent"}
        />,
      );
      continue;
    }

    const k = (msg as { kind?: string }).kind;
    if (k === "reasoning") {
      rows.push(
        <ReasoningRow
          key={msg.id}
          msg={msg as Extract<ChatMessage, { kind: "reasoning" }>}
          // Still "Thinking…" only while this is the last row and the turn is
          // streaming; once the answer arrives (or history loads) it becomes
          // a completed "Thought".
          active={isLoading && i === windowedMessages.length - 1}
          showAvatar={showAvatar}
        />,
      );
      continue;
    }

    if (k === "clarify") {
      rows.push(
        <ClarifyCard
          key={msg.id}
          msg={msg as ClarifyMessage}
          onResolved={onClarifyResolved}
        />,
      );
      continue;
    }

    const bubble = msg as Extract<ChatMessage, { role: "user" | "agent" }>;
    rows.push(
      <MessageRow
        key={msg.id}
        msg={bubble}
        isLast={msg.id === lastVisibleBubbleId}
        isLoading={isLoading}
        onApprove={onApprove}
        onDeny={onDeny}
        showAvatar={showAvatar}
      />,
    );
  }

  return (
    <>
      <div
        className={hasEarlier ? "chat-transcript-earlier" : undefined}
        ref={earlierMarkerRef}
      >
        {hasEarlier && (
          <button
            type="button"
            className="chat-transcript-earlier-btn"
            onClick={expandEarlier}
          >
            {t("chat.showEarlierMessages", {
              count: hiddenMessageCount > 0 ? hiddenMessageCount : hiddenCount,
            })}
          </button>
        )}
      </div>

      {rows}

      {isLoading && !lastMessageIsAgent && (
        <TypingIndicator toolProgress={toolProgress} />
      )}

      {isLoading && toolProgress && lastMessageIsAgent && (
        <div className="chat-tool-progress-inline">{toolProgress}</div>
      )}
    </>
  );
});
