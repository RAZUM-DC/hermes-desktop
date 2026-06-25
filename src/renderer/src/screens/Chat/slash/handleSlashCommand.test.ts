import { describe, expect, it, vi } from "vitest";
import { createSlashCatalog } from "./commandCatalog";
import { DESKTOP_SLASH_COMMANDS } from "./desktopCommands";
import { handleSlashCommand } from "./handleSlashCommand";
import type { AgentSlashCommand, SlashCommandContext } from "./types";

function createMockContext(overrides?: Partial<SlashCommandContext>): SlashCommandContext {
  return {
    attachments: [],
    isModelBusy: false,
    requestAgent: vi.fn().mockResolvedValue({ output: "mock agent output" }),
    submitPrompt: vi.fn().mockResolvedValue(undefined),
    enqueuePrompt: vi.fn(),
    addSystemMessage: vi.fn(),
    openSettings: vi.fn(),
    openDialog: vi.fn(),
    startNewChat: vi.fn(),
    clearTranscript: vi.fn(),
    ...overrides,
  };
}

describe("handleSlashCommand", () => {
  const agentCommands: AgentSlashCommand[] = [
    {
      name: "status",
      description: "Check status",
      category: "Agent",
      source: "agent",
      target: "agent",
      allowWhileBusy: true,
    },
  ];

  const catalog = createSlashCatalog({
    desktopCommands: DESKTOP_SLASH_COMMANDS,
    agentCommands,
    aliases: { c: "status" },
  });

  it("routes desktop command correctly", async () => {
    const ctx = createMockContext();
    const res = await handleSlashCommand("/settings appearance", catalog, ctx);
    expect(res).toEqual({ type: "handled", output: undefined });
    expect(ctx.openSettings).toHaveBeenCalledWith("appearance");
    expect(ctx.submitPrompt).not.toHaveBeenCalled();
  });

  it("routes agent command correctly via RPC", async () => {
    const ctx = createMockContext();
    const res = await handleSlashCommand("/status", catalog, ctx);
    expect(res).toEqual({ type: "handled" });
    expect(ctx.requestAgent).toHaveBeenCalledWith("slash.exec", {
      command: "status",
      session_id: "",
    });
  });

  it("routes model command correctly to submitPrompt", async () => {
    const ctx = createMockContext();
    const res = await handleSlashCommand("/explain-selection make it simple", catalog, ctx);
    expect(res.type).toBe("submitted");
    expect(ctx.submitPrompt).toHaveBeenCalledTimes(1);
    expect(ctx.enqueuePrompt).not.toHaveBeenCalled();
  });

  it("queues model command when model is busy", async () => {
    const ctx = createMockContext({ isModelBusy: true });
    // explain-selection has allowWhileBusy: false, so let's register a custom busy-allowed model command
    const busyCatalog = createSlashCatalog({
      desktopCommands: [
        {
          name: "summarize",
          description: "sum",
          category: "Model",
          source: "desktop",
          target: "model",
          allowWhileBusy: true,
          format: async () => ({ content: "summarized" }),
        },
      ],
    });

    const res = await handleSlashCommand("/summarize", busyCatalog, ctx);
    expect(res.type).toBe("queued");
    expect(ctx.enqueuePrompt).toHaveBeenCalledTimes(1);
    expect(ctx.submitPrompt).not.toHaveBeenCalled();
  });

  it("rejects command when busy and allowWhileBusy is false", async () => {
    const ctx = createMockContext({ isModelBusy: true });
    const res = await handleSlashCommand("/explain-selection", catalog, ctx);
    expect(res).toEqual({
      type: "error",
      message: "/explain-selection cannot run while the current turn is active",
    });
  });

  it("returns error for unknown command without hitting LLM", async () => {
    const ctx = createMockContext();
    const res = await handleSlashCommand("/unknown-cmd", catalog, ctx);
    expect(res).toEqual({
      type: "error",
      message: "Unknown command: /unknown-cmd",
    });
    expect(ctx.submitPrompt).not.toHaveBeenCalled();
  });

  it("resolves alias correctly", async () => {
    const ctx = createMockContext();
    const res = await handleSlashCommand("/c", catalog, ctx);
    expect(res.type).toBe("handled");
    expect(ctx.requestAgent).toHaveBeenCalledWith("slash.exec", {
      command: "c",
      session_id: "",
    });
  });
});
