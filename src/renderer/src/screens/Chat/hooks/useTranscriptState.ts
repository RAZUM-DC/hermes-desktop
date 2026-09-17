import { useCallback, useRef, useState } from "react";
import type { ChatMessage } from "../types";

/**
 * Transcript state with a synchronous write-through ref.
 *
 * Dashboard streaming updates the ref between React commits. Resolving every
 * functional writer against that ref prevents a user action, clear, failure,
 * or clarification response from overwriting chunks received in the same
 * animation frame.
 */
export function useTranscriptState(initial?: ChatMessage[]): {
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  messagesRef: React.MutableRefObject<ChatMessage[]>;
} {
  const [messages, rawSetMessages] = useState<ChatMessage[]>(initial ?? []);
  const messagesRef = useRef<ChatMessage[]>(messages);
  const setMessages = useCallback(
    (action: React.SetStateAction<ChatMessage[]>): void => {
      const next =
        typeof action === "function" ? action(messagesRef.current) : action;
      messagesRef.current = next;
      rawSetMessages(next);
    },
    [],
  );
  return { messages, setMessages, messagesRef };
}
