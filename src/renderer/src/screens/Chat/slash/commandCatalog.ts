import type { SlashCommandCatalog, SlashCommandDefinition } from "./types";

export interface CreateCatalogOptions {
  agentCommands?: SlashCommandDefinition[];
  desktopCommands?: SlashCommandDefinition[];
  aliases?: Record<string, string>;
}

export function createSlashCatalog({
  agentCommands = [],
  desktopCommands = [],
  aliases = {},
}: CreateCatalogOptions): SlashCommandCatalog {
  const byName = new Map<string, SlashCommandDefinition>();
  const aliasMap = new Map<string, string>();

  // 1. Register Hermes Agent commands
  for (const cmd of agentCommands) {
    const key = cmd.name.toLowerCase();
    byName.set(key, cmd);
    if (cmd.aliases) {
      for (const a of cmd.aliases) {
        aliasMap.set(a.toLowerCase(), key);
      }
    }
  }

  // 2. Register Desktop commands (validate collisions)
  for (const cmd of desktopCommands) {
    const key = cmd.name.toLowerCase();
    if (byName.has(key)) {
      console.warn(`Catalog collision: Desktop command /${cmd.name} shadows an Agent command`);
      continue;
    }
    byName.set(key, cmd);
    if (cmd.aliases) {
      for (const a of cmd.aliases) {
        const aliasKey = a.toLowerCase();
        if (byName.has(aliasKey) || aliasMap.has(aliasKey)) {
          console.warn(`Catalog collision: Alias /${a} already registered`);
          continue;
        }
        aliasMap.set(aliasKey, key);
      }
    }
  }

  // 3. Register explicit aliases
  for (const [alias, target] of Object.entries(aliases)) {
    const aliasKey = alias.toLowerCase();
    const targetKey = target.toLowerCase();
    if (!byName.has(targetKey)) {
      console.warn(`Catalog error: Alias /${alias} points to unknown command /${target}`);
      continue;
    }
    aliasMap.set(aliasKey, targetKey);
  }

  const commands = Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return {
    commands,
    byName,
    aliases: aliasMap,
    resolve(name: string): SlashCommandDefinition | undefined {
      const key = name.toLowerCase();
      const resolvedName = aliasMap.get(key) ?? key;
      return byName.get(resolvedName);
    },
  };
}
