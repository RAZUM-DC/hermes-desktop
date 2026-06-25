import type { ModelCommandFormatter, SlashCommandDefinition } from "./types";

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
    supportsAttachments: true,
    format: formatExplainSelection,
  },
  {
    name: "help",
    aliases: ["commands"],
    description: "Show available commands",
    category: "Desktop",
    source: "desktop",
    target: "desktop",
    allowWhileBusy: true,
    execute: async (_input, context) => ({
      type: "handled",
      output: context.renderSlashHelp(),
    }),
  },
];

const LOCAL_COMMANDS = [
  ["new", "Start a new chat"],
  ["clear", "Clear conversation history"],
  ["persona", "Show the current persona"],
] as const;

export const LOCAL_DESKTOP_SLASH_COMMANDS: SlashCommandDefinition[] =
  LOCAL_COMMANDS.map(([name, description]) => ({
    name,
    description,
    category: "Desktop",
    source: "desktop",
    target: "desktop",
    allowWhileBusy: true,
    execute: async (input, context) => {
      const handled = await context.executeDesktopSlash(input.rawInput);
      return handled
        ? { type: "handled" as const }
        : {
            type: "error" as const,
            message: `Desktop command /${input.name} is unavailable`,
          };
    },
  }));
