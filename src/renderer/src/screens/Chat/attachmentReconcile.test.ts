import { describe, expect, it } from "vitest";
import { reconcileAfterDbRefresh } from "./sessionHistory";
import type { ChatMessage } from "./types";

const shot = {
  id: "att-1",
  kind: "image" as const,
  name: "screenshot.png",
  mime: "image/png",
  size: 1234,
  dataUrl: "data:image/png;base64,AAA",
};

function streamedUser(content: string): ChatMessage {
  return {
    id: "user-1",
    role: "user",
    content,
    attachments: [shot],
  } as ChatMessage;
}

function dbUser(content: string): ChatMessage {
  return { id: "db-7", role: "user", content } as ChatMessage;
}

describe("вложение в пузыре после обновления из базы", () => {
  it("переживает совпадающий текст", () => {
    const out = reconcileAfterDbRefresh([streamedUser("а")], [dbUser("а")]);
    const user = out.find((m) => "role" in m && m.role === "user");
    expect((user as { attachments?: unknown[] }).attachments).toHaveLength(1);
  });

  it("переживает хвостовой маркер [screenshot] в копии из базы", () => {
    const out = reconcileAfterDbRefresh(
      [streamedUser("а")],
      [dbUser("а [screenshot]")],
    );
    const user = out.find((m) => "role" in m && m.role === "user");
    expect((user as { attachments?: unknown[] }).attachments).toHaveLength(1);
  });

  it("переживает ведущий блок vision-фоллбэка в копии из базы", () => {
    const out = reconcileAfterDbRefresh(
      [streamedUser("а")],
      [dbUser("[Image attached at: C:/tmp/a.png] а")],
    );
    const user = out.find((m) => "role" in m && m.role === "user");
    expect((user as { attachments?: unknown[] }).attachments).toHaveLength(1);
  });
});
