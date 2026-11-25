import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp",
    setPath: () => {},
    on: () => {},
  },
  BrowserWindow: class {},
  ipcMain: { handle: () => {} },
  dialog: { showSaveDialog: vi.fn() },
}));

import { promptAttachmentKey } from "./session-attachment-store";
import {
  applySessionLocalOverlays,
  mergePromptImageAttachments,
} from "./sessions";
import type { HistoryItem } from "./sessions";
import type { Attachment } from "../shared/attachments";

const PNG = "data:image/png;base64,aGVsbG8=";

function image(name: string): Attachment {
  return {
    id: `att-${name}`,
    kind: "image",
    name,
    mime: "image/png",
    size: 5,
    dataUrl: PNG,
  };
}

/** HistoryItem is a union; only the user variant carries these. */
function attachmentsOf(item: HistoryItem): Attachment[] | undefined {
  return item.kind === "user" ? item.attachments : undefined;
}

function contentOf(item: HistoryItem): string {
  return item.kind === "user" ? item.content : "";
}

function userItem(id: number, content: string): HistoryItem {
  return { id, kind: "user", content, timestamp: id } as HistoryItem;
}

describe("promptAttachmentKey", () => {
  it("ignores the marker the agent leaves where the picture was", () => {
    // The transcript comes back as text with `[screenshot]` in place of the
    // image, so the key has to be computed the same either way.
    expect(promptAttachmentKey("опиши скриншот\n[screenshot]")).toBe(
      promptAttachmentKey("опиши скриншот"),
    );
    expect(promptAttachmentKey("look  at   this")).toBe("look at this");
    expect(promptAttachmentKey("[image]")).toBe("");
  });
});

describe("mergePromptImageAttachments", () => {
  it("puts a stored picture back on the message it was sent with", () => {
    const stored = new Map([
      [promptAttachmentKey("опиши скриншот"), [[image("shot.png")]]],
    ]);

    const merged = mergePromptImageAttachments(
      [userItem(1, "опиши скриншот\n[screenshot]")],
      stored,
    );

    expect(attachmentsOf(merged[0])?.[0].name).toBe("shot.png");
  });

  it("gives repeated prompts their own pictures, in order", () => {
    const stored = new Map([
      [
        promptAttachmentKey("смотри"),
        [[image("first.png")], [image("second.png")]],
      ],
    ]);

    const merged = mergePromptImageAttachments(
      [userItem(1, "смотри"), userItem(2, "смотри")],
      stored,
    );

    expect(attachmentsOf(merged[0])?.[0].name).toBe("first.png");
    expect(attachmentsOf(merged[1])?.[0].name).toBe("second.png");
  });

  it("leaves a message that already carries its attachments alone", () => {
    const live = { ...userItem(1, "смотри"), attachments: [image("live.png")] };
    const stored = new Map([
      [promptAttachmentKey("смотри"), [[image("stored.png")]]],
    ]);

    const merged = mergePromptImageAttachments([live], stored);

    expect(attachmentsOf(merged[0])?.[0].name).toBe("live.png");
  });

  it("does not touch anything that is not a user message", () => {
    const assistant = {
      id: 2,
      kind: "assistant",
      content: "смотри",
    } as HistoryItem;
    const stored = new Map([
      [promptAttachmentKey("смотри"), [[image("shot.png")]]],
    ]);

    expect(mergePromptImageAttachments([assistant], stored)[0]).toBe(assistant);
  });

  it("returns the transcript untouched when nothing is stored", () => {
    const items = [userItem(1, "смотри")];
    expect(mergePromptImageAttachments(items, new Map())).toBe(items);
  });
});

describe("applySessionLocalOverlays without any database", () => {
  it("still strips the marker instead of showing it to the user", () => {
    // Remote mode: no agent state.db on this machine, and no desktop database
    // either. This used to return the transcript untouched, so the user saw a
    // bare `[screenshot]` where the picture should have been.
    const restored = applySessionLocalOverlays("session-1", [
      userItem(1, "опиши скриншот\n[screenshot]"),
    ]);

    expect(restored).toHaveLength(1);
    expect(contentOf(restored[0])).toBe("опиши скриншот");
  });
});
