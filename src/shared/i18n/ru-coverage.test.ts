import { describe, expect, it } from "vitest";
import enSettings from "./locales/en/settings";
import ruSettings from "./locales/ru/settings";
import enNavigation from "./locales/en/navigation";
import ruNavigation from "./locales/ru/navigation";
import enAgents from "./locales/en/agents";
import ruAgents from "./locales/ru/agents";
import enChat from "./locales/en/chat";
import ruChat from "./locales/ru/chat";
import enCommon from "./locales/en/common";
import ruCommon from "./locales/ru/common";

/**
 * Русский — основной язык продукта, и пропущенный в нём ключ не ломает сборку:
 * i18next молча подставляет английский. Так в меню настроек и оказались
 * «Appearance», «Language» и «Data» посреди русского интерфейса. Этот тест
 * ловит такие пропуски до того, как их увидит пользователь.
 *
 * Остальные языки сознательно не проверяются: там переведено далеко не всё, и
 * падающий тест на каждую новую английскую строку мешал бы работать.
 */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    keyPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

function missingIn(en: unknown, ru: unknown): string[] {
  const have = new Set(keyPaths(ru));
  return keyPaths(en).filter((path) => !have.has(path));
}

describe("русская локаль покрывает английскую", () => {
  it("settings", () => {
    expect(missingIn(enSettings, ruSettings)).toEqual([]);
  });

  it("navigation", () => {
    expect(missingIn(enNavigation, ruNavigation)).toEqual([]);
  });

  it("agents", () => {
    expect(missingIn(enAgents, ruAgents)).toEqual([]);
  });

  it("chat", () => {
    expect(missingIn(enChat, ruChat)).toEqual([]);
  });

  it("common", () => {
    expect(missingIn(enCommon, ruCommon)).toEqual([]);
  });
});
