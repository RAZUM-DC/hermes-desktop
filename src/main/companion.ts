import { spawn, ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { app } from "electron";
import { HERMES_HOME } from "./installer";

// Hermes Companion — локальный сопроцесс (config_owner): enroll, LLM/mem-шимы и
// супервизия tool-connector'а (локальные инструменты fs/shell на машине
// пользователя). Бинарь бандлится в resources/bin (electron-builder
// extraResources). Здесь только запуск/останов; вся логика — в Go-бинаре.

const IS_WINDOWS = process.platform === "win32";
let proc: ChildProcess | null = null;

function companionBinary(): string | null {
  const name = IS_WINDOWS ? "companion.exe" : "companion";
  const candidates = [
    join(process.resourcesPath || "", "bin", name),
    join(app.getAppPath(), "..", "bin", name),
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

export function startCompanion(): void {
  if (proc) return;
  if (process.env.HERMES_DISABLE_COMPANION === "1") return;
  const bin = companionBinary();
  if (!bin) {
    console.warn(
      "[companion] binary not found in resources/bin — local tools disabled",
    );
    return;
  }
  try {
    proc = spawn(bin, ["run"], {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // КРИТИЧНО: companion пишет desktop.json в ТОТ ЖЕ HERMES_HOME, что
      // читает приложение (иначе remote-конфиг не виден -> остаётся Welcome).
      env: { ...process.env, HERMES_HOME },
    });
    proc.stdout?.on("data", (d) =>
      console.log("[companion]", String(d).trimEnd()),
    );
    proc.stderr?.on("data", (d) =>
      console.log("[companion]", String(d).trimEnd()),
    );
    proc.on("exit", (code) => {
      console.log("[companion] exited", code);
      proc = null;
    });
    console.log("[companion] started:", bin);
  } catch (e) {
    console.error("[companion] spawn failed:", e);
    proc = null;
  }
}

export function stopCompanion(): void {
  if (!proc) return;
  try {
    proc.kill();
  } catch {
    /* best effort */
  }
  proc = null;
}
