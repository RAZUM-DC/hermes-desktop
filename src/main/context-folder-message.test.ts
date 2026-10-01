import { describe, expect, it } from "vitest";
import { contextFolderSystemMessage } from "./hermes";

describe("contextFolderSystemMessage", () => {
  it("без папки сообщение не создаётся", () => {
    expect(contextFolderSystemMessage(undefined)).toBeNull();
    expect(contextFolderSystemMessage("")).toBeNull();
    expect(contextFolderSystemMessage("   ")).toBeNull();
  });

  it("в гибриде велит работать через local.* и запрещает серверные руки", () => {
    const msg = contextFolderSystemMessage(
      "C:\\Users\\ivan\\Documents\\Проект",
      "remote",
    );
    expect(msg?.content).toContain("local.fs_read");
    expect(msg?.content).toContain("own computer");
    // Главное свойство: серверные инструменты названы запрещёнными явно —
    // иначе агент возьмёт их по привычке из общего промпта.
    expect(msg?.content).toContain("Do not use execute_code");
    expect(msg?.content).not.toContain("terminal, and code-execution tools");
  });

  it("локально и по SSH — прежний текст про файловые инструменты", () => {
    for (const mode of ["local", "ssh"] as const) {
      const msg = contextFolderSystemMessage("/srv/project", mode);
      expect(msg?.content).toContain("code-execution tools");
      expect(msg?.content).not.toContain("local.fs_read");
    }
  });

  it("путь попадает в текст как есть", () => {
    const p = "C:\\Users\\ivan\\Desktop\\отчёты";
    expect(contextFolderSystemMessage(p, "remote")?.content).toContain(p);
    expect(contextFolderSystemMessage(`  ${p}  `, "remote")?.content).toContain(
      p,
    );
  });
});
