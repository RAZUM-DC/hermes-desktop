import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { app } from "electron";

// Hermes Voice Sidecar — локальное, полностью офлайн распознавание речи для
// кнопки микрофона в чате. Отдельный Rust-бинарь (candle + квантованная
// многоязычная модель Whisper "tiny", GGUF), собранный по тому же принципу,
// что companion/tool-connector: бандлится в resources/bin (electron-builder
// extraResources). Здесь только запуск процесса и обмен по stdin/stdout —
// вся ML-логика находится в Rust-бинаре.
//
// Протокол сайдкара: WAV (16 kHz, mono, PCM) на stdin -> одна строка JSON на
// stdout:
//   {"text": "..."}   при успехе (exit code 0)
//   {"error": "..."}  при ошибке (и ненулевой exit code)
//
// Бинарь собран пока только под Windows (x86_64-pc-windows-gnullvm) — на
// остальных платформах isVoiceSidecarAvailable() вернёт false, и вызывающий
// код (useVoiceInput.ts) откатывается на существующую облачную транскрипцию
// через transcribeAudio().

interface SidecarResponse {
  text?: string;
  error?: string;
}

const IS_WINDOWS = process.platform === "win32";

function voiceSidecarBinary(): string | null {
  if (!IS_WINDOWS) return null; // бинарь пока собран только под Windows
  const name = "voice-sidecar.exe";
  const candidates = [
    join(process.resourcesPath || "", "bin", name),
    join(app.getAppPath(), "..", "bin", name),
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

// %LOCALAPPDATA%\HermesVoice — кэш скачанной Whisper-модели (~40MB суммарно
// для config/tokenizer/weights). Модель качается один раз при первом
// использовании (или заранее через warmVoiceSidecar()), а дальше
// распознавание работает полностью офлайн, без Hermes API server.
function modelCacheDir(): string {
  const local = process.env.LOCALAPPDATA;
  const dir = local
    ? join(local, "HermesVoice")
    : join(app.getPath("home"), ".hermes-voice");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort — sidecar само создаст каталог при необходимости */
  }
  return dir;
}

export function isVoiceSidecarAvailable(): boolean {
  return voiceSidecarBinary() !== null;
}

/**
 * Прогревает кэш модели заранее (вызывается один раз при старте приложения),
 * чтобы первое нажатие на кнопку микрофона не зависало на скачивании модели.
 * Не бросает исключений — это best-effort фоновая операция.
 */
export function warmVoiceSidecar(): void {
  const bin = voiceSidecarBinary();
  if (!bin) return;
  try {
    const proc = spawn(bin, ["--warm"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, HERMES_VOICE_MODEL_DIR: modelCacheDir() },
    });
    proc.stdout?.on("data", (d) =>
      console.log("[voice-sidecar]", String(d).trimEnd()),
    );
    proc.stderr?.on("data", (d) =>
      console.log("[voice-sidecar]", String(d).trimEnd()),
    );
    proc.on("error", (e) =>
      console.warn("[voice-sidecar] warm-up spawn failed:", e),
    );
  } catch (e) {
    console.warn("[voice-sidecar] warm-up spawn failed:", e);
  }
}

/**
 * Распознаёт речь ЛОКАЛЬНО — без сети и без запущенного Hermes API server.
 *
 * `wav` — 16 kHz mono PCM WAV (декодирование записанного webm/opus в этот
 * формат происходит в рендерере через Web Audio API, см.
 * decodeToWav16kMono() в useVoiceInput.ts, — сайдкар никогда не имеет дела
 * с WebM/Opus напрямую).
 *
 * Отклоняет промис, если бинарь не забандлен для этой платформы или процесс
 * завершился с ошибкой — вызывающий код должен откатиться на облачную
 * transcribeAudio().
 */
export function transcribeAudioLocally(
  wav: Uint8Array,
  language = "ru",
): Promise<string> {
  const bin = voiceSidecarBinary();
  if (!bin) {
    return Promise.reject(
      new Error("Local voice recognition isn't bundled for this platform."),
    );
  }

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, ["--language", language], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, HERMES_VOICE_MODEL_DIR: modelCacheDir() },
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      let result: SidecarResponse | null = null;
      try {
        result = JSON.parse(line) as SidecarResponse;
      } catch {
        result = null;
      }
      if (result?.error) {
        reject(new Error(result.error));
        return;
      }
      if (code !== 0 || !result) {
        reject(
          new Error(
            `Local voice recognition failed (${
              code ?? "unknown"
            }). ${stderr.slice(0, 200).trim()}`.trim(),
          ),
        );
        return;
      }
      resolve((result.text || "").trim());
    });

    proc.stdin?.write(Buffer.from(wav));
    proc.stdin?.end();
  });
}
