import type {
  ModelCommandFormatter,
  SlashCommandDefinition,
} from "./types";

const formatExplainSelection: ModelCommandFormatter = async (input) => ({
  content: [
    "Explain the following content clearly.",
    input.args && `Additional instructions:\n${input.args}`,
    input.selectedText && `Content:\n${input.selectedText}`,
  ]
    .filter(Boolean)
    .join("\n\n"),
  attachments: input.attachments,
});

// @lat: [[chat-commands#Slash command execution#Central command router#Desktop commands]]
export const DESKTOP_SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    name: "settings",
    description: "Open Desktop settings",
    category: "Desktop",
    source: "desktop",
    target: "desktop",
    allowWhileBusy: true,
    execute: async ({ args }, context) => {
      context.openSettings(args || undefined);
      return { type: "handled" };
    },
  },
  {
    name: "explain-selection",
    description: "Explain the selected content",
    category: "Desktop",
    source: "desktop",
    target: "model",
    allowWhileBusy: false,
    format: formatExplainSelection,
  },
];
