import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { app } from "electron";

// Hermes Voice Sidecar — локальное, полностью офлайн распознавание речи для
// кнопки микрофона в чате. Отдельный Rust-бинарь: GigaAM v3 e2e CTC
// (Sber, MIT) в ONNX int8 через onnxruntime, собранный по тому же принципу,
// что companion/tool-connector: бандлится в resources/bin (electron-builder
// extraResources). Рядом с exe лежит onnxruntime.dll — сайдкар грузит её
// динамически, по имени. Здесь только запуск процесса и обмен по
// stdin/stdout — вся ML-логика находится в Rust-бинаре.
//
// Ядро распознаёт только русский: аргумент --language принимается ради
// совместимости со старым вызовом и игнорируется.
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

// %LOCALAPPDATA%\HermesVoice — кэш скачанной модели GigaAM (~215MB: веса
// в ONNX int8 плюс словарь токенов). Модель качается один раз при первом
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
  /** Ответ наблюдателя за комбинацией: "released" | "absent". */
  hold?: string;
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

/**
 * Разбор stdout/stderr сайдкара и завершение всех ожидающих при его смерти.
 * Общий код для разового (`--record`) и резидентного (`--serve`) процессов.
 */
function attachSidecarStreams(s: RecordingSession, onClose?: () => void): void {
  s.proc.stdout?.on("data", (chunk: Buffer) => {
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
  s.proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    s.stderr += text;
    console.log("[voice-sidecar]", text.trimEnd());
  });
  s.proc.on("error", (e) => {
    s.finished = true;
    settleAll(s, e instanceof Error ? e : new Error(String(e)));
  });
  s.proc.on("close", (code) => {
    s.finished = true;
    onClose?.();
    settleAll(
      s,
      new Error(
        `Voice sidecar exited (${code ?? "unknown"}). ${s.stderr
          .slice(-200)
          .trim()}`.trim(),
      ),
    );
  });
}

function send(s: RecordingSession, command: string): void {
  s.proc.stdin?.write(`${command}\n`);
}

// ---------------------------------------------------------------------------
// Резидентный сайдкар (--serve).
//
// Зачем: старт процесса и открытие микрофона занимают ощутимое время. Для
// кнопки в чате это незаметно — человек нажимает и начинает говорить. Для
// диктовки по горячей клавише («зажал, сказал, отпустил») это смертельно:
// ожидание приходится ровно на момент, когда говорить уже закончили. Поэтому
// один процесс поднимается при старте приложения и обслуживает сколько
// угодно записей.
//
// Саму модель резидентный процесс в памяти НЕ держит: 215MB весов висели бы
// в RAM всё время работы приложения ради нескольких секунд диктовки в день.
// Сессия onnxruntime поднимается на команду `start` — параллельно записи —
// и освобождается сразу после `stop`/`cancel`. К моменту, когда человек
// договорил, она уже готова, так что задержки это не добавляет.
//
// Микрофон при этом открыт только между `start` и `stop`: в простое
// резидентный процесс к устройству не обращается.

let daemon: RecordingSession | null = null;
let daemonStarting: Promise<RecordingSession | null> | null = null;

function spawnDaemon(language: string): Promise<RecordingSession | null> {
  const bin = voiceSidecarBinary();
  if (!bin) return Promise.resolve(null);

  let proc: ChildProcess;
  try {
    proc = spawn(bin, ["--serve", "--language", language], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, HERMES_VOICE_MODEL_DIR: modelCacheDir() },
    });
  } catch (e) {
    console.warn("[voice-sidecar] resident spawn failed:", e);
    return Promise.resolve(null);
  }

  const s: RecordingSession = {
    proc,
    waiters: [],
    stdout: "",
    stderr: "",
    finished: false,
  };
  attachSidecarStreams(s);
  proc.on("close", () => {
    if (daemon === s) daemon = null;
  });

  // Модель грузится до первой команды; ждём подтверждения.
  return waitFor(s, (m) => m.status === "ready")
    .then(() => {
      daemon = s;
      console.log("[voice-sidecar] resident process ready");
      return s;
    })
    .catch((e) => {
      console.warn("[voice-sidecar] resident sidecar never became ready:", e);
      try {
        s.proc.kill();
      } catch {
        /* уже мог умереть сам */
      }
      return null;
    });
}

/**
 * Поднимает резидентный сайдкар, если он ещё не поднят. Возвращает null, если
 * бинаря нет или он не смог стартовать — вызывающий код должен откатиться на
 * разовый запуск.
 */
function ensureDaemon(language = "ru"): Promise<RecordingSession | null> {
  if (daemon && !daemon.finished) return Promise.resolve(daemon);
  if (!daemonStarting) {
    daemonStarting = spawnDaemon(language).finally(() => {
      daemonStarting = null;
    });
  }
  return daemonStarting;
}

/** Запускает резидентный сайдкар заранее, при старте приложения. */
export function warmVoiceDaemon(language = "ru"): void {
  void ensureDaemon(language).catch(() => undefined);
}

/** Останавливает резидентный процесс (выход из приложения). */
export function stopVoiceDaemon(): void {
  const s = daemon;
  daemon = null;
  if (!s) return;
  try {
    send(s, "quit");
    s.proc.kill();
  } catch {
    /* уже мог умереть сам */
  }
}

/** Идёт ли запись через резидентный сайдкар. */
function daemonIsRecording(): boolean {
  return daemonRecording;
}

let daemonRecording = false;

/**
 * Запускает запись: поднимает сайдкар в режиме --record и ждёт подтверждения,
 * что микрофон реально открылся. Промис отклоняется, если бинарь не забандлен
 * или устройство открыть не удалось — вызывающий код должен откатиться на
 * getUserMedia/MediaRecorder.
 */
function startOneShotRecording(language: string): Promise<void> {
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
  attachSidecarStreams(s, () => {
    if (session === s) session = null;
  });

  return waitFor(s, (m) => m.status === "recording").then(() => undefined);
}

/**
 * Начинает запись. Сначала пробуем резидентный процесс — у него модель уже в
 * памяти, поэтому финальная расшифровка приходит почти мгновенно. Если его
 * нет или он отказался, откатываемся на разовый запуск: там модель грузится
 * заново, но запись всё равно состоится.
 */
export async function startLocalRecording(language = "ru"): Promise<void> {
  try {
    const d = await ensureDaemon(language);
    if (d && !d.finished) {
      send(d, "start");
      await waitFor(d, (m) => m.status === "recording");
      daemonRecording = true;
      return;
    }
  } catch (e) {
    console.warn("[voice-sidecar] resident start failed, falling back:", e);
    daemonRecording = false;
  }
  return startOneShotRecording(language);
}

/**
 * Промежуточный текст «на лету»: сайдкар прогоняет через модель всё, что
 * записано на данный момент, не прерывая запись. Пустая строка — нормальный
 * ответ (модель ещё грузится или человек пока молчит).
 */
export function partialLocalTranscript(): Promise<string> {
  if (daemonIsRecording() && daemon && !daemon.finished) {
    const d = daemon;
    send(d, "partial");
    return waitFor(d, (m) => typeof m.partial === "string").then((m) =>
      (m.partial || "").trim(),
    );
  }
  const s = session;
  if (!s || s.finished) return Promise.reject(new Error("Not recording."));
  send(s, "partial");
  return waitFor(s, (m) => typeof m.partial === "string").then((m) =>
    (m.partial || "").trim(),
  );
}

/** Останавливает запись и отдаёт финальную расшифровку. */
export function stopLocalRecording(): Promise<string> {
  if (daemonIsRecording() && daemon && !daemon.finished) {
    const d = daemon;
    daemonRecording = false;
    send(d, "stop");
    return waitFor(d, (m) => typeof m.text === "string").then((m) =>
      (m.text || "").trim(),
    );
  }
  const s = session;
  if (!s || s.finished) return Promise.reject(new Error("Not recording."));
  send(s, "stop");
  return waitFor(s, (m) => typeof m.text === "string").then((m) => {
    if (session === s) session = null;
    return (m.text || "").trim();
  });
}

/** Прерывает запись без расшифровки (закрытие окна, смена вкладки, ошибка). */
/**
 * Просит резидентный сайдкар последить за комбинацией и сказать, когда её
 * отпустят.
 *
 * Почему не силами Electron: регистрируя глобальную комбинацию, Windows
 * перехватывает её целиком, и отпускание не доходит ни до одного окна. Опрос
 * состояния конкретных клавиш — единственный способ узнать, что человек
 * договорил и разжал пальцы. Наблюдатель живёт только на время диктовки.
 *
 * Возвращает "released" (отпустили — пора заканчивать), "absent" (зажать не
 * успели, удержания не было) или null, если резидентного процесса нет.
 */
export async function watchHotkeyRelease(
  vks: number[],
): Promise<"released" | "absent" | null> {
  if (vks.length === 0) return null;
  // Наблюдателю резидентный процесс нужен сам по себе, а не потому, что через
  // него идёт запись: он только опрашивает клавиши. Поэтому поднимаем его и в
  // том случае, если сама запись почему-то ушла на разовый запуск.
  const d = daemon && !daemon.finished ? daemon : await ensureDaemon();
  if (!d || d.finished) {
    console.warn("[voice-sidecar] no resident process to watch the hotkey");
    return null;
  }
  send(d, `watchkeys ${vks.join(",")}`);
  try {
    const msg = await waitFor(d, (m) => typeof m.hold === "string");
    const result = msg.hold === "released" ? "released" : "absent";
    console.log("[voice-sidecar] hotkey watch:", result);
    return result;
  } catch (e) {
    console.warn("[voice-sidecar] hotkey watch failed:", e);
    return null;
  }
}

export function cancelLocalRecording(): void {
  if (daemonIsRecording() && daemon && !daemon.finished) {
    daemonRecording = false;
    try {
      send(daemon, "cancel");
    } catch {
      /* процесс мог умереть — следующая запись поднимет новый */
    }
    return;
  }
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
  if (daemonIsRecording()) return true;
  return session !== null && !session.finished;
}
