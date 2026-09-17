import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

vi.mock("./MessageRow", () => ({
  HermesAvatar: () => <div data-testid="avatar" />,
  MessageRow: ({
    msg,
    isLast,
    showAvatar,
  }: {
    msg: { id: string };
    isLast: boolean;
    showAvatar: boolean;
  }) => (
    <div
      data-testid="bubble"
      data-islast={isLast ? "1" : "0"}
      data-avatar={showAvatar ? "1" : "0"}
    >
      {msg.id}
    </div>
  ),
}));

vi.mock("./HistoryRow", () => ({
  ReasoningRow: ({
    msg,
    showAvatar,
  }: {
    msg: { id: string };
    showAvatar: boolean;
  }) => (
    <div data-testid="reasoning" data-avatar={showAvatar ? "1" : "0"}>
      {msg.id}
    </div>
  ),
  ToolActivityGroup: ({
    items,
    showAvatar,
  }: {
    items: { id: string }[];
    showAvatar: boolean;
  }) => (
    <div data-testid="tool-group" data-avatar={showAvatar ? "1" : "0"}>
      {items.map((item) => item.id).join(",")}
    </div>
  ),
}));

vi.mock("./ClarifyCard", () => ({
  ClarifyCard: ({ msg }: { msg: { id: string } }) => (
    <div data-testid="clarify">{msg.id}</div>
  ),
}));

import { MessageList, TRANSCRIPT_WINDOW } from "./MessageList";
import type { ChatMessage } from "./types";

function bubble(id: string, role: "user" | "agent" = "user"): ChatMessage {
  return { id, role, content: `content ${id}` } as ChatMessage;
}

function toolCall(id: string): ChatMessage {
  return {
    id,
    kind: "tool_call",
    role: "agent",
    callId: `call-${id}`,
    name: "terminal",
    args: "{}",
  } as ChatMessage;
}

function renderList(messages: ChatMessage[]): ReturnType<typeof render> {
  return render(
    <MessageList
      messages={messages}
      isLoading={false}
      toolProgress={null}
      onApprove={vi.fn()}
      onDeny={vi.fn()}
      onClarifyResolved={vi.fn()}
    />,
  );
}

describe("MessageList transcript windowing", () => {
  it("renders every row when the transcript is short", () => {
    renderList(Array.from({ length: 20 }, (_, i) => bubble(`m${i}`)));
    expect(screen.getAllByTestId("bubble")).toHaveLength(20);
    expect(screen.queryByText(/showEarlierMessages/)).toBeNull();
  });

  it("mounts only the newest window in a long transcript", () => {
    const total = TRANSCRIPT_WINDOW + 50;
    renderList(Array.from({ length: total }, (_, i) => bubble(`m${i}`)));

    expect(screen.getAllByTestId("bubble")).toHaveLength(TRANSCRIPT_WINDOW);
    expect(screen.getByText(`m${total - 1}`)).toBeTruthy();
    expect(screen.queryByText("m0")).toBeNull();
    expect(screen.getByText(/"count":50/)).toBeTruthy();
  });

  it("reveals one additional window per button click", () => {
    const total = TRANSCRIPT_WINDOW * 2 + 10;
    renderList(Array.from({ length: total }, (_, i) => bubble(`m${i}`)));

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByTestId("bubble")).toHaveLength(TRANSCRIPT_WINDOW * 2);
    expect(screen.getByText(/"count":10/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByTestId("bubble")).toHaveLength(total);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not split a normal tool-call run at the window boundary", () => {
    const head = Array.from({ length: 40 }, (_, i) => bubble(`h${i}`));
    const run = Array.from({ length: 5 }, (_, i) => toolCall(`t${i}`));
    const tail = Array.from({ length: TRANSCRIPT_WINDOW - 3 }, (_, i) =>
      bubble(`b${i}`),
    );
    renderList([...head, ...run, ...tail]);

    expect(screen.getByTestId("tool-group").textContent).toBe("t0,t1,t2,t3,t4");
  });

  it("keeps the newest bubble mounted behind a long reasoning run", () => {
    const reasoning = Array.from(
      { length: TRANSCRIPT_WINDOW + 20 },
      (_, i) =>
        ({
          id: `r${i}`,
          kind: "reasoning",
          role: "agent",
          text: `step ${i}`,
        }) as ChatMessage,
    );
    renderList([bubble("u1"), bubble("a1", "agent"), ...reasoning]);

    const marked = screen
      .getAllByTestId("bubble")
      .filter((row) => row.dataset.islast === "1");
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toBe("a1");
  });

  it("keeps an unresolved clarification available outside the normal window", () => {
    const pending = {
      id: "pending",
      kind: "clarify",
      role: "agent",
      requestId: "request-1",
      question: "Choose",
      choices: [],
      resolved: false,
    } as ChatMessage;
    const messages = [
      bubble("u0"),
      pending,
      ...Array.from({ length: 150 }, (_, i) => bubble(`tail${i}`, "agent")),
    ];
    const { rerender } = renderList(messages);
    expect(screen.getByTestId("clarify")).toHaveTextContent("pending");

    rerender(
      <MessageList
        messages={messages.map((message) =>
          message.id === "pending"
            ? ({ ...message, resolved: true } as ChatMessage)
            : message,
        )}
        isLoading={false}
        toolProgress={null}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onClarifyResolved={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("clarify")).toBeNull();
  });

  it("pins the visible history boundary while new rows stream in", () => {
    const messages = Array.from({ length: 250 }, (_, i) => bubble(`m${i}`));
    const view = (rows: ChatMessage[]): React.JSX.Element => (
      <div className="chat-messages">
        <MessageList
          messages={rows}
          isLoading={false}
          toolProgress={null}
          onApprove={vi.fn()}
          onDeny={vi.fn()}
          onClarifyResolved={vi.fn()}
        />
      </div>
    );
    const { container, rerender } = render(view(messages));
    const scroll = container.firstElementChild as HTMLElement;
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);

    rerender(
      view([
        ...messages,
        ...Array.from({ length: 110 }, (_, i) => bubble(`new${i}`, "agent")),
      ]),
    );
    expect(screen.getByText("m150")).toBeTruthy();
    expect(screen.getByText("new109")).toBeTruthy();

    scroll.scrollTop = 800;
    fireEvent.scroll(scroll);
    expect(screen.queryByText("m150")).toBeNull();
    expect(screen.getAllByTestId("bubble")).toHaveLength(TRANSCRIPT_WINDOW);
  });

  it("resets the expanded history when the conversation changes", () => {
    const total = TRANSCRIPT_WINDOW * 2 + 10;
    const chatA = Array.from({ length: total }, (_, i) => bubble(`a${i}`));
    const { rerender } = renderList(chatA);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByTestId("bubble")).toHaveLength(TRANSCRIPT_WINDOW * 2);

    const chatB = Array.from({ length: total }, (_, i) => bubble(`b${i}`));
    rerender(
      <MessageList
        messages={chatB}
        isLoading={false}
        toolProgress={null}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onClarifyResolved={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId("bubble")).toHaveLength(TRANSCRIPT_WINDOW);
  });

  it("automatically expands when the top marker enters the viewport", () => {
    let trigger: (() => void) | undefined;
    class ObserverStub {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(): void {
        trigger = () =>
          this.cb(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      disconnect(): void {
        trigger = undefined;
      }
    }
    vi.stubGlobal("IntersectionObserver", ObserverStub);
    try {
      const total = TRANSCRIPT_WINDOW + 40;
      renderList(Array.from({ length: total }, (_, i) => bubble(`m${i}`)));
      expect(screen.getAllByTestId("bubble")).toHaveLength(TRANSCRIPT_WINDOW);
      act(() => trigger?.());
      expect(screen.getAllByTestId("bubble")).toHaveLength(total);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
