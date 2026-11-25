// hermes-voice-sidecar: локальное распознавание речи для РАЗУМ Ассистента.
//
// Ядро — GigaAM v3 e2e CTC от SberDevices (MIT), экспортированная в ONNX и
// квантованная в int8. Работает офлайн: модель качается один раз в кэш и
// дальше живёт на диске. Вариант `e2e` выдаёт текст сразу со знаками
// препинания и нормализацией чисел.
//
// Модель НЕ держится в памяти между диктовками: 215 МБ резидентно — слишком
// дорого для функции, которой пользуются несколько раз в час. Вместо этого
// сессия поднимается в фоне сразу после начала записи и освобождается, когда
// запись закончена: человек говорит те же пару секунд, что модель грузится,
// и ожидания не замечает.
//
// Весь вывод — по одному JSON-объекту на строку: {"status":...},
// {"partial":...}, {"text":...} или {"error":...}. Ошибки тоже JSON, чтобы
// вызывающей стороне не приходилось разбирать stderr.

use anyhow::{bail, Context, Result};
use clap::Parser;
use std::io::{self, BufRead, Read, Write};

use crate::asr::Recognizer;
use crate::fbank::SAMPLE_RATE;

mod asr;
mod fbank;
mod capture;
mod wasapi;
mod winmm;

#[derive(Parser, Debug)]
#[command(author, version, about = "Local speech-to-text for РАЗУМ Ассистент")]
struct Args {
    /// Принимается ради совместимости с прежним вызовом и игнорируется:
    /// ядро распознаёт только русский.
    #[arg(long, default_value = "ru")]
    language: String,

    /// Capture from the microphone ourselves (WASAPI shared mode via cpal)
    /// instead of receiving a WAV on stdin. Driven by line commands on stdin:
    /// `partial` for an interim transcript, `stop` to finish.
    #[arg(long)]
    record: bool,

    /// Резидентный режим: процесс живёт между диктовками и принимает на
    /// stdin команды `start`/`partial`/`stop`/`cancel`. Модель при этом в
    /// памяти не висит — она поднимается на время записи.
    #[arg(long)]
    serve: bool,

    /// List every microphone endpoint/format this machine exposes and report
    /// which ones can actually be opened. Diagnostic only — prints and exits.
    #[arg(long)]
    probe_audio: bool,

    /// Only download/cache the model and exit — used to warm the cache
    /// ahead of time from the main process instead of on the first
    /// button-press (which would otherwise stall the UI).
    #[arg(long)]
    warm: bool,
}

/// Read a WAV file from `r` and return (mono f32 samples in [-1, 1], sample_rate).
fn read_wav(r: impl Read) -> Result<(Vec<f32>, u32)> {
    let mut reader = hound::WavReader::new(r).context("not a valid WAV stream")?;
    let spec = reader.spec();
    if spec.channels != 1 {
        bail!(
            "expected mono audio, got {} channels (resample/downmix before sending)",
            spec.channels
        );
    }
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<std::result::Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max))
                .collect::<std::result::Result<_, _>>()?
        }
    };
    Ok((samples, spec.sample_rate))
}

/// Модель на время диктовки: поднимается в фоне и освобождается после.
///
/// Загрузка 215 МБ занимает секунду-другую, и платить её после того, как
/// человек договорил, нельзя — ожидание будет заметным. Поэтому сессия
/// начинает грузиться одновременно с началом записи, а к моменту `stop`
/// обычно уже готова.
enum Model {
    Idle,
    Loading(std::thread::JoinHandle<Result<Recognizer>>),
    Ready(Box<Recognizer>),
    Failed(String),
}

impl Model {
    fn begin(&mut self) {
        if matches!(self, Model::Idle | Model::Failed(_)) {
            *self = Model::Loading(std::thread::spawn(Recognizer::load));
        }
    }

    /// Дожидается загрузки. Ошибка запоминается: второй раз подряд качать
    /// модель, которая только что не скачалась, смысла нет.
    fn get(&mut self) -> Result<&mut Recognizer> {
        if let Model::Idle = self {
            self.begin();
        }
        if let Model::Loading(_) = self {
            let Model::Loading(handle) = std::mem::replace(self, Model::Idle) else {
                unreachable!()
            };
            *self = match handle.join() {
                Ok(Ok(rec)) => Model::Ready(Box::new(rec)),
                Ok(Err(e)) => Model::Failed(format!("{e:#}")),
                Err(_) => Model::Failed("model loading thread panicked".into()),
            };
        }
        match self {
            Model::Ready(rec) => Ok(rec),
            Model::Failed(msg) => bail!("{msg}"),
            _ => unreachable!(),
        }
    }

    /// Запись окончена — память возвращаем системе.
    fn release(&mut self) {
        *self = Model::Idle;
    }
}

/// `--record`: микрофон наш, а не Chromium.
///
/// Запись начинается раньше загрузки модели, чтобы не срезать начало фразы, и
/// модель грузится параллельно. Дальше вызывающая сторона командует построчно:
///   partial -> распознать накопленное, {"partial": "..."}
///   stop    -> закончить и распознать всё, {"text": "..."}
/// Закрытие stdin равносильно `stop`: упавший родитель не должен оставить
/// микрофон открытым.
fn record(_args: &Args) -> Result<String> {
    let capture = wasapi::Capture::start().context("opening the microphone")?;
    emit(&serde_json::json!({ "status": "recording" }));
    eprintln!(
        "[voice-sidecar] capturing from {} -> {} Hz",
        capture.description(),
        capture::TARGET_RATE
    );

    let mut model = Model::Idle;
    model.begin();

    let stdin = io::stdin();
    loop {
        let mut line = String::new();
        if stdin.lock().read_line(&mut line)? == 0 {
            break; // parent went away
        }
        match line.trim() {
            "partial" => {
                let text = match model.get() {
                    Ok(rec) => rec.transcribe(&capture.samples_16k()).unwrap_or_default(),
                    Err(_) => String::new(),
                };
                emit(&serde_json::json!({ "partial": text }));
            }
            "stop" => break,
            "" => {}
            other => eprintln!("[voice-sidecar] ignoring unknown command: {other}"),
        }
    }

    capture.stop();
    let samples = capture.samples_16k();
    let text = model.get()?.transcribe(&samples)?;
    model.release();
    Ok(text)
}

/// `--serve`: один процесс, много диктовок.
///
/// Модель между диктовками не держится: её поднимает `start` в фоне и
/// освобождает `stop`. Команды по одной в строке на stdin:
///   start   -> открыть микрофон,      {"status":"recording"}
///   partial -> распознать накопленное,{"partial":"..."}
///   stop    -> закончить и распознать,{"text":"..."}
///   cancel  -> выбросить запись,      {"status":"idle"}
///   quit    -> выйти (как и закрытие stdin, чтобы упавший родитель не
///              оставил микрофон открытым)
///
/// Упавшая команда отвечает `{"error":...}`, а процесс остаётся жив: одна
/// неудачная запись не должна стоить вызывающей стороне всего сеанса.
fn serve(_args: &Args) -> Result<()> {
    emit(&serde_json::json!({ "status": "ready" }));

    let mut capture: Option<wasapi::Capture> = None;
    let mut model = Model::Idle;
    let stdin = io::stdin();
    loop {
        let mut line = String::new();
        if stdin.lock().read_line(&mut line)? == 0 {
            break; // parent went away
        }
        match line.trim() {
            "start" => {
                if capture.is_some() {
                    emit(&serde_json::json!({ "status": "recording" }));
                    continue;
                }
                match wasapi::Capture::start() {
                    Ok(c) => {
                        eprintln!("[voice-sidecar] capturing from {}", c.description());
                        capture = Some(c);
                        // Модель грузится параллельно записи: к «стоп» она
                        // обычно уже готова, и человек ожидания не видит.
                        model.begin();
                        emit(&serde_json::json!({ "status": "recording" }));
                    }
                    Err(e) => emit(&serde_json::json!({
                        "error": format!("opening the microphone: {e:#}")
                    })),
                }
            }
            "partial" => {
                let text = match (&capture, model.get()) {
                    (Some(c), Ok(rec)) => rec.transcribe(&c.samples_16k()).unwrap_or_default(),
                    _ => String::new(),
                };
                emit(&serde_json::json!({ "partial": text }));
            }
            "stop" => {
                stop_watching();
                let Some(c) = capture.take() else {
                    model.release();
                    emit(&serde_json::json!({ "text": "" }));
                    continue;
                };
                c.stop();
                let samples = c.samples_16k();
                match model.get().and_then(|rec| rec.transcribe(&samples)) {
                    Ok(text) => emit(&serde_json::json!({ "text": text })),
                    Err(e) => emit(&serde_json::json!({
                        "error": format!("transcribing: {e:#}")
                    })),
                }
                model.release();
            }
            other if other.starts_with("watchkeys ") => {
                let vks: Vec<i32> = other["watchkeys ".len()..]
                    .split(',')
                    .filter_map(|p| p.trim().parse::<i32>().ok())
                    .collect();
                watch_hold(vks);
            }
            "cancel" => {
                stop_watching();
                if let Some(c) = capture.take() {
                    c.stop();
                }
                model.release();
                emit(&serde_json::json!({ "status": "idle" }));
            }
            "quit" => break,
            "" => {}
            other => eprintln!("[voice-sidecar] ignoring unknown command: {other}"),
        }
    }

    if let Some(c) = capture.take() {
        c.stop();
    }
    Ok(())
}

// --- Удержание комбинации ---------------------------------------------------
//
// Зачем это здесь, а не в Electron: регистрируя глобальную комбинацию, Windows
// перехватывает её целиком — ни нажатие, ни отпускание не доходят до окон, так
// что «пишем, пока зажато» через обычные события клавиатуры недостижимо.
// Остаётся спросить систему о состоянии конкретных клавиш.
//
// Важно, чем это НЕ является: никакого хука на клавиатуру не ставится, чужие
// нажатия не читаются и не сохраняются. Опрашиваются две-три клавиши самой
// комбинации и только между началом и концом диктовки — вне её поток не
// существует вовсе.

/// Поколение наблюдателя: новая команда (или конец записи) гасит предыдущий
/// поток, не дожидаясь, пока он сам заметит.
static WATCH_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Сколько ждать, пока комбинация окажется зажатой. Если за это время она так
/// и не собралась, человек отпустил клавиши раньше, чем мы начали смотреть —
/// удержания не было, и вызывающая сторона остаётся в режиме переключателя.
const HOLD_ARM_TIMEOUT_MS: u64 = 700;
const HOLD_POLL_INTERVAL_MS: u64 = 20;

fn key_is_down(vk: i32) -> bool {
    // Старший бит — «клавиша нажата сейчас».
    (unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk) } as u16 & 0x8000)
        != 0
}

fn stop_watching() {
    WATCH_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// Следит за комбинацией в отдельном потоке и один раз сообщает результат:
/// `{"hold":"released"}` — комбинацию отпустили, пора заканчивать запись;
/// `{"hold":"absent"}`   — её не успели зажать, удержания не было.
fn watch_hold(vks: Vec<i32>) {
    use std::sync::atomic::Ordering::SeqCst;
    let generation = WATCH_GENERATION.fetch_add(1, SeqCst) + 1;
    if vks.is_empty() {
        emit(&serde_json::json!({ "hold": "absent" }));
        return;
    }
    std::thread::spawn(move || {
        let poll = std::time::Duration::from_millis(HOLD_POLL_INTERVAL_MS);
        let armed_by = std::time::Instant::now()
            + std::time::Duration::from_millis(HOLD_ARM_TIMEOUT_MS);
        let mut armed = false;
        while std::time::Instant::now() < armed_by {
            if WATCH_GENERATION.load(SeqCst) != generation {
                return;
            }
            if vks.iter().all(|&vk| key_is_down(vk)) {
                armed = true;
                break;
            }
            std::thread::sleep(poll);
        }
        if !armed {
            emit(&serde_json::json!({ "hold": "absent" }));
            return;
        }
        loop {
            if WATCH_GENERATION.load(SeqCst) != generation {
                return;
            }
            if !vks.iter().all(|&vk| key_is_down(vk)) {
                emit(&serde_json::json!({ "hold": "released" }));
                return;
            }
            std::thread::sleep(poll);
        }
    });
}

/// One JSON object per line on stdout — the only thing the Electron side parses.
fn emit(value: &serde_json::Value) {
    println!("{value}");
    let _ = io::stdout().flush();
}

/// Does the real work. Kept separate from `main` so every failure path —
/// not just the ones after stdin has been read — gets a chance to be
/// reported as `{"error": "..."}` JSON on stdout instead of anyhow's
/// plain-text default, which would otherwise land only on stderr and leave
/// the Electron side with nothing parseable to read.
fn run(args: &Args) -> Result<Option<String>> {
    if args.warm {
        // Только скачать: поднимать сессию заранее незачем, в памяти она
        // между диктовками всё равно не живёт.
        asr::model_files()
            .context("fetching/locating the recognition model (needs network on first run)")?;
        eprintln!("[voice-sidecar] model cached, ready for offline use");
        return Ok(None);
    }

    if args.probe_audio {
        wasapi::probe()?;
        return Ok(None);
    }

    if args.serve {
        serve(args)?;
        return Ok(None);
    }

    if args.record {
        return record(args).map(Some);
    }

    // Запасной путь: уже раскодированный WAV 16 кГц моно приходит на stdin.
    // Остался для машин, где запись идёт через MediaRecorder в рендерере.
    let (pcm_data, sample_rate) =
        read_wav(io::stdin().lock()).context("reading WAV audio from stdin")?;
    if sample_rate != SAMPLE_RATE as u32 {
        bail!(
            "expected {} Hz audio on stdin, got {} Hz",
            SAMPLE_RATE,
            sample_rate
        );
    }
    let mut recognizer = Recognizer::load()?;
    Ok(Some(recognizer.transcribe(&pcm_data)?))
}

fn main() {
    let args = Args::parse();
    match run(&args) {
        Ok(Some(text)) => {
            emit(&serde_json::json!({ "text": text }));
        }
        Ok(None) => {
            // --warm: nothing to print on stdout, the stderr message already
            // told the caller the cache is ready.
        }
        Err(err) => {
            // Always emit valid JSON on stdout on failure too, so the
            // Electron side can `JSON.parse` stdout unconditionally instead
            // of having to special-case a non-zero exit code.
            emit(&serde_json::json!({ "error": format!("{err:#}") }));
            eprintln!("[voice-sidecar] {err:#}");
            std::process::exit(1);
        }
    }
}
