import { spawn, type ChildProcess } from "child_process";
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

// ---------------------------------------------------------------------------
// Захват звука самим сайдкаром (режим --record).
//
// Зачем: Chromium открывает WASAPI-устройство в raw-режиме, когда считает, что
// обработка звука не нужна (WASAPIAudioInputStream::SetCommunicationsCategory
// AndMaybeRawCaptureMode). На микрофонных массивах Intel Smart Sound это
// обходит APO драйвера, и IAudioClient::Initialize отвечает E_INVALIDARG
// (0x80070057) — в рендерере это выглядит как "NotReadableError: Could not
// start audio source". Штатная "Запись голоса" Windows на том же железе
// работает, потому что raw-режим не запрашивает.
//
// Поэтому микрофон открывает сайдкар (cpal → WASAPI shared mode, как у
// "Записи голоса"), а весь аудиостек Chromium из цепочки исключён.
//
// Протокол: одна JSON-строка на stdout за раз.
//   {"status":"recording"} — микрофон открыт (дальше можно показывать
//                            индикатор записи);
//   {"status":"ready"}     — модель загружена, можно просить partial;
//   {"partial":"..."}      — промежуточный текст в ответ на команду `partial`;
//   {"text":"..."}         — финальный текст в ответ на `stop`;
//   {"error":"..."}        — ошибка, процесс завершается.

interface SidecarMessage {
  status?: string;
  partial?: string;
  text?: string;
  error?: string;
}

interface Waiter {
  wants: (msg: SidecarMessage) => boolean;
  resolve: (msg: SidecarMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RecordingSession {
  proc: ChildProcess;
  waiters: Waiter[];
  stdout: string;
  stderr: string;
  finished: boolean;
}

let session: RecordingSession | null = null;

// Загрузка модели на холодном старте занимает несколько секунд, распознавание
// минутного фрагмента на CPU — тоже; но висеть вечно нельзя, иначе зависший
// сайдкар навсегда оставит кнопку микрофона в состоянии «записываю».
const REPLY_TIMEOUT_MS = 60_000;

function settleAll(s: RecordingSession, err: Error): void {
  const waiters = s.waiters.splice(0, s.waiters.length);
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.reject(err);
  }
}

function dispatch(s: RecordingSession, msg: SidecarMessage): void {
  if (msg.error) {
    settleAll(s, new Error(msg.error));
    return;
  }
  const idx = s.waiters.findIndex((w) => w.wants(msg));
  if (idx === -1) return; // статус, которого никто не ждёт — просто лог
  const [w] = s.waiters.splice(idx, 1);
  clearTimeout(w.timer);
  w.resolve(msg);
}

/** Ждёт от сайдкара сообщение нужного вида. */
function waitFor(
  s: RecordingSession,
  wants: (msg: SidecarMessage) => boolean,
): Promise<SidecarMessage> {
  if (s.finished) {
    const detail = `Voice sidecar exited. ${s.stderr.slice(-200).trim()}`;
    return Promise.reject(new Error(detail.trim()));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = s.waiters.findIndex((w) => w.timer === timer);
      if (idx !== -1) s.waiters.splice(idx, 1);
      reject(new Error("Voice sidecar timed out."));
    }, REPLY_TIMEOUT_MS);
    s.waiters.push({ wants, resolve, reject, timer });
  });
}

function send(s: RecordingSession, command: string): void {
  s.proc.stdin?.write(`${command}\n`);
}

/**
 * Запускает запись: поднимает сайдкар в режиме --record и ждёт подтверждения,
 * что микрофон реально открылся. Промис отклоняется, если бинарь не забандлен
 * или устройство открыть не удалось — вызывающий код должен откатиться на
 * getUserMedia/MediaRecorder.
 */
export function startLocalRecording(language = "ru"): Promise<void> {
  const bin = voiceSidecarBinary();
  if (!bin) {
    return Promise.reject(
      new Error("Local voice recognition isn't bundled for this platform."),
    );
  }
  // Подстраховка: одна запись за раз.
  cancelLocalRecording();

  let proc: ChildProcess;
  try {
    proc = spawn(bin, ["--record", "--language", language], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, HERMES_VOICE_MODEL_DIR: modelCacheDir() },
    });
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }

  const s: RecordingSession = {
    proc,
    waiters: [],
    stdout: "",
    stderr: "",
    finished: false,
  };
  session = s;

  proc.stdout?.on("data", (chunk: Buffer) => {
    s.stdout += chunk.toString("utf-8");
    // Сайдкар пишет по одному JSON-объекту на строку; хвост без \n
    // оставляем в буфере до следующего чанка.
    const lines = s.stdout.split(/\r?\n/);
    s.stdout = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: SidecarMessage | null = null;
      try {
        msg = JSON.parse(line) as SidecarMessage;
      } catch {
        console.warn("[voice-sidecar] non-JSON line:", line.slice(0, 200));
        continue;
      }
      dispatch(s, msg);
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    s.stderr += text;
    console.log("[voice-sidecar]", text.trimEnd());
  });
  proc.on("error", (e) => {
    s.finished = true;
    settleAll(s, e instanceof Error ? e : new Error(String(e)));
  });
  proc.on("close", (code) => {
    s.finished = true;
    if (session === s) session = null;
    settleAll(
      s,
      new Error(
        `Voice sidecar exited (${code ?? "unknown"}). ${s.stderr
          .slice(-200)
          .trim()}`.trim(),
      ),
    );
  });

  return waitFor(s, (m) => m.status === "recording").then(() => undefined);
}

/**
 * Промежуточный текст «на лету»: сайдкар прогоняет через Whisper всё, что
 * записано на данный момент, не прерывая запись. Пустая строка — нормальный
 * ответ (модель ещё грузится или человек пока молчит).
 */
export function partialLocalTranscript(): Promise<string> {
  const s = session;
  if (!s || s.finished) return Promise.reject(new Error("Not recording."));
  send(s, "partial");
  return waitFor(s, (m) => typeof m.partial === "string").then((m) =>
    (m.partial || "").trim(),
  );
}

/** Останавливает запись и отдаёт финальную расшифровку. */
export function stopLocalRecording(): Promise<string> {
  const s = session;
  if (!s || s.finished) return Promise.reject(new Error("Not recording."));
  send(s, "stop");
  return waitFor(s, (m) => typeof m.text === "string").then((m) => {
    if (session === s) session = null;
    return (m.text || "").trim();
  });
}

/** Прерывает запись без расшифровки (закрытие окна, смена вкладки, ошибка). */
export function cancelLocalRecording(): void {
  const s = session;
  if (!s) return;
  session = null;
  s.finished = true;
  settleAll(s, new Error("Recording cancelled."));
  try {
    s.proc.kill();
  } catch {
    /* процесс уже мог завершиться сам */
  }
}

/** Идёт ли сейчас запись через сайдкар. */
export function isLocalRecordingActive(): boolean {
  return session !== null && !session.finished;
}
