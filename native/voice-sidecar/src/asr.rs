//! Распознавание речи на GigaAM v3 e2e CTC.
//!
//! Ядро — экспортированная в ONNX модель от SberDevices (MIT), int8, ~215 МБ.
//! Вариант `e2e` выбран сознательно: он выдаёт текст сразу со знаками
//! препинания и нормализацией чисел, а для диктовки это и есть половина дела.
//!
//! Почему ONNX Runtime подключается динамически: сайдкар собирается mingw'ом и
//! слинкован статически, а официальные сборки onnxruntime собраны MSVC.
//! Линковать их вместе нельзя, но и не нужно — библиотека грузится в рантайме
//! через LoadLibrary, а на границе только C ABI, которому компилятор безразличен.
//!
//! Модель в сборку не кладётся: 215 МБ качаются при первом использовании в тот
//! же кэш, где раньше лежали веса whisper.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;

use crate::fbank::{Fbank, SAMPLE_RATE};

/// Экспорт GigaAM v3 e2e CTC под sherpa-onnx: одна сессия, словарь BPE.
const MODEL_REPO: &str = "nocmt/GigaAM-v3-E2E-CTC-int8-ONNX";
const MODEL_FILE: &str = "model.int8.onnx";
const TOKENS_FILE: &str = "tokens.txt";
/// Ожидаемый размер модели — грубая проверка, что скачалось целиком.
const MODEL_MIN_BYTES: u64 = 150 * 1024 * 1024;

/// Короче этого — не речь, а щелчок кнопки: гонять через модель нечего.
const MIN_SAMPLES: usize = SAMPLE_RATE / 5;

pub fn cache_dir() -> Result<PathBuf> {
    let dir = match std::env::var_os("HERMES_VOICE_MODEL_DIR") {
        Some(p) => PathBuf::from(p),
        None => std::env::temp_dir().join("hermes-voice-model"),
    };
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating the model cache dir {}", dir.display()))?;
    Ok(dir)
}

fn http_agent() -> ureq::Agent {
    // Провайдер задаём явно: rustls в ureq собран по умолчанию, но без
    // выбора провайдера он паникует при первом запросе. На Windows
    // native-tls — это SChannel.
    //
    // root_certs тоже задаём явно, и это не перестраховка. По умолчанию ureq
    // ставит `RootCerts::WebPki`: отключает системные корни целиком
    // (`disable_built_in_roots(true)`) и доверяет только вшитому списку
    // Mozilla. На рабочей машине с корпоративным антивирусом или шлюзом
    // трафик к huggingface.co пересматривается на лету и пересобирается на
    // локальный корень (у Kaspersky — свой), которого в списке Mozilla нет и
    // быть не может. Скачивание падало с
    //   native-tls: unable to find any user-specified roots in the final cert chain
    // то есть цепочка проверилась, но упёрлась в корень, которому мы сами
    // запретили доверять.
    //
    // PlatformVerifier возвращает нормальное поведение: доверяем тому, чему
    // доверяет Windows. Для настольного приложения на управляемой машине это
    // единственный разумный вариант — список корней там ведёт администратор,
    // а не мы.
    ureq::Agent::config_builder()
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .into()
}

fn download(agent: &ureq::Agent, url: &str, to: &Path, label: &str) -> Result<()> {
    let mut resp = agent
        .get(url)
        .call()
        .with_context(|| format!("downloading {url}"))?;
    let total = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);

    // Пишем во временный файл: оборванная закачка не должна оставить
    // полумодель, которая потом молча не загрузится.
    let tmp = to.with_extension("part");
    let mut file = std::fs::File::create(&tmp)
        .with_context(|| format!("creating {}", tmp.display()))?;
    let mut reader = resp.body_mut().as_reader();
    let mut buf = vec![0u8; 1 << 20];
    let mut done: u64 = 0;
    let mut last_report = 0u64;
    loop {
        let n = reader.read(&mut buf).context("reading the download stream")?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        done += n as u64;
        if total > 0 {
            let percent = done * 100 / total;
            if percent >= last_report + 5 {
                last_report = percent;
                crate::emit(&serde_json::json!({
                    "status": "downloading", "file": label, "percent": percent
                }));
            }
        }
    }
    file.flush()?;
    drop(file);
    std::fs::rename(&tmp, to)
        .with_context(|| format!("moving {} into place", tmp.display()))?;
    Ok(())
}

/// Пути к модели и словарю, скачивая их при первом обращении.
pub fn model_files() -> Result<(PathBuf, PathBuf)> {
    let dir = cache_dir()?;
    let model = dir.join(MODEL_FILE);
    let tokens = dir.join(TOKENS_FILE);

    let model_ok = std::fs::metadata(&model)
        .map(|m| m.len() >= MODEL_MIN_BYTES)
        .unwrap_or(false);
    let tokens_ok = std::fs::metadata(&tokens).map(|m| m.len() > 0).unwrap_or(false);
    if model_ok && tokens_ok {
        return Ok((model, tokens));
    }

    let agent = http_agent();
    if !tokens_ok {
        let url = format!("https://huggingface.co/{MODEL_REPO}/resolve/main/{TOKENS_FILE}");
        download(&agent, &url, &tokens, TOKENS_FILE)?;
    }
    if !model_ok {
        let url = format!("https://huggingface.co/{MODEL_REPO}/resolve/main/{MODEL_FILE}");
        eprintln!("[voice-sidecar] downloading the recognition model (~215 MB), first run only");
        download(&agent, &url, &model, MODEL_FILE)?;
    }
    Ok((model, tokens))
}

/// Путь к onnxruntime.dll рядом с самим сайдкаром.
///
/// Задаём его сами, а не полагаемся на поиск по PATH: библиотека едет в
/// сборке вместе с нами, и брать чужую копию из системы — верный способ
/// однажды получить несовместимую версию.
fn locate_runtime() -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("ORT_DYLIB_PATH") {
        return Ok(PathBuf::from(p));
    }
    let exe = std::env::current_exe().context("locating the sidecar executable")?;
    let dir = exe
        .parent()
        .context("the sidecar executable has no parent directory")?;
    let dll = dir.join("onnxruntime.dll");
    if !dll.exists() {
        bail!(
            "onnxruntime.dll not found next to {} — it ships with the app in resources/bin/win",
            exe.display()
        );
    }
    Ok(dll)
}

/// Словарь BPE: кусок текста на каждый идентификатор.
fn read_tokens(path: &Path) -> Result<Vec<String>> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;
    let mut pieces: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            continue;
        }
        // Формат sherpa: «<кусок> <id>», разделитель — последний пробел.
        let (piece, id) = match line.rsplit_once(' ') {
            Some((p, i)) => (p, i),
            None => bail!("malformed tokens line: {line}"),
        };
        let id: usize = id
            .trim()
            .parse()
            .with_context(|| format!("malformed token id in line: {line}"))?;
        if pieces.len() <= id {
            pieces.resize(id + 1, String::new());
        }
        pieces[id] = piece.to_string();
    }
    if pieces.len() < 2 {
        bail!("the token vocabulary is empty");
    }
    Ok(pieces)
}

pub struct Recognizer {
    session: Session,
    pieces: Vec<String>,
    blank: usize,
    fbank: Arc<Fbank>,
}

impl Recognizer {
    pub fn load() -> Result<Self> {
        let (model_path, tokens_path) = model_files()
            .context("fetching/locating the recognition model (needs network on first run)")?;
        let dll = locate_runtime()?;
        // ort в режиме динамической загрузки читает путь из переменной
        // окружения — выставляем её до первого обращения к библиотеке.
        std::env::set_var("ORT_DYLIB_PATH", &dll);

        let pieces = read_tokens(&tokens_path)?;
        // Пустой символ у экспортов sherpa всегда последний.
        let blank = pieces.len() - 1;

        // Потоков ровно столько, сколько ядер, но не больше четырёх: дальше
        // выигрыша почти нет, а диктовка идёт на машине, которая в этот момент
        // занята чем-то ещё.
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(4))
            .unwrap_or(2);
        // Ошибки ort несут внутри себя сырые указатели, поэтому они не Send и
        // не Sync и не приводятся к anyhow::Error напрямую. Сворачиваем всю
        // сборку сессии в один шаг и переносим наружу только текст ошибки.
        let session = (|| -> std::result::Result<Session, String> {
            Session::builder()
                .map_err(|e| e.to_string())?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|e| e.to_string())?
                .with_intra_threads(threads)
                .map_err(|e| e.to_string())?
                .commit_from_file(&model_path)
                .map_err(|e| e.to_string())
        })()
        .map_err(|e| anyhow!("loading the model {}: {e}", model_path.display()))?;

        Ok(Self {
            session,
            pieces,
            blank,
            fbank: Arc::new(Fbank::new()),
        })
    }

    pub fn transcribe(&mut self, pcm: &[f32]) -> Result<String> {
        if pcm.len() < MIN_SAMPLES {
            return Ok(String::new());
        }
        let (feats, frames) = self.fbank.compute(pcm);
        if frames == 0 {
            return Ok(String::new());
        }

        // Имена входов/выходов взяты из самого экспорта:
        //   features       f32  [batch, 64, seq_len]
        //   feature_lengths i64 [batch]
        //   log_probs      f32  [batch, seq_len/4, 257]
        // (у оригинального чекпойнта NeMo они назывались audio_signal/length —
        // в этом экспорте нет, менять здесь вслепую нельзя).
        let signal = Tensor::from_array((vec![1i64, 64, frames as i64], feats))
            .context("building the input tensor")?;
        let length = Tensor::from_array((vec![1i64], vec![frames as i64]))
            .context("building the length tensor")?;

        let outputs = self
            .session
            .run(ort::inputs!["features" => signal, "feature_lengths" => length])
            .context("running the recognition model")?;
        let (shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .context("reading the model output")?;
        if shape.len() != 3 {
            bail!("unexpected model output rank: {shape:?}");
        }
        let steps = shape[1] as usize;
        let vocab = shape[2] as usize;

        Ok(decode_ctc(data, steps, vocab, self.blank, &self.pieces))
    }
}

/// Жадное CTC-декодирование: лучший символ на кадре, схлопнуть повторы,
/// выбросить пустой, склеить куски BPE.
fn decode_ctc(
    logprobs: &[f32],
    steps: usize,
    vocab: usize,
    blank: usize,
    pieces: &[String],
) -> String {
    let mut out = String::new();
    let mut prev = usize::MAX;
    for t in 0..steps {
        let row = &logprobs[t * vocab..(t + 1) * vocab];
        let mut best = 0usize;
        let mut best_v = f32::MIN;
        for (i, v) in row.iter().enumerate() {
            if *v > best_v {
                best_v = *v;
                best = i;
            }
        }
        // Повтор того же символа в CTC — это продолжение одного звука, а не
        // второй такой же: склеиваем. Пустой символ разделяет повторы.
        if best != blank && best != prev {
            if let Some(piece) = pieces.get(best) {
                // «▁» у sentencepiece означает начало слова, то есть пробел.
                out.push_str(&piece.replace('\u{2581}', " "));
            }
        }
        prev = best;
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vocab() -> Vec<String> {
        vec![
            "<unk>".into(),
            "\u{2581}".into(),
            "прив".into(),
            "ет".into(),
            ".".into(),
            "<blk>".into(),
        ]
    }

    /// Раскладывает последовательность идентификаторов в «логарифмы»: у
    /// нужного символа ноль, у остальных минус единица.
    fn frames(ids: &[usize], vocab_size: usize) -> Vec<f32> {
        let mut out = vec![-1.0f32; ids.len() * vocab_size];
        for (t, id) in ids.iter().enumerate() {
            out[t * vocab_size + id] = 0.0;
        }
        out
    }

    #[test]
    fn collapses_repeats_and_drops_blanks() {
        let v = vocab();
        let blank = v.len() - 1;
        let ids = [blank, 1, 2, 2, 2, 3, blank, 4, blank];
        let logprobs = frames(&ids, v.len());
        assert_eq!(
            decode_ctc(&logprobs, ids.len(), v.len(), blank, &v),
            "привет."
        );
    }

    #[test]
    fn blank_between_repeats_keeps_both() {
        let v = vocab();
        let blank = v.len() - 1;
        // «ет» + пустой + «ет» — это два разных куска, а не один растянутый.
        let ids = [2, 3, blank, 3];
        let logprobs = frames(&ids, v.len());
        assert_eq!(
            decode_ctc(&logprobs, ids.len(), v.len(), blank, &v),
            "приветет"
        );
    }

    #[test]
    fn word_marker_becomes_a_space_and_edges_are_trimmed() {
        let v = vocab();
        let blank = v.len() - 1;
        let ids = [1, 2, 3, 1, 2, 3, 1];
        let logprobs = frames(&ids, v.len());
        assert_eq!(
            decode_ctc(&logprobs, ids.len(), v.len(), blank, &v),
            "привет привет"
        );
    }

    #[test]
    fn silence_decodes_to_nothing() {
        let v = vocab();
        let blank = v.len() - 1;
        let ids = [blank; 12];
        let logprobs = frames(&ids, v.len());
        assert_eq!(decode_ctc(&logprobs, ids.len(), v.len(), blank, &v), "");
    }

    #[test]
    fn tokens_file_is_parsed_by_trailing_id() {
        let dir = std::env::temp_dir().join(format!("gigaam-tokens-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tokens.txt");
        // Первая строка содержит пробел как сам токен — разбор по последнему
        // пробелу, а не по первому, иначе словарь поедет.
        std::fs::write(&path, "<unk> 0\n\u{2581} 1\n. 2\n<blk> 3\n").unwrap();
        let pieces = read_tokens(&path).unwrap();
        assert_eq!(pieces.len(), 4);
        assert_eq!(pieces[1], "\u{2581}");
        assert_eq!(pieces[3], "<blk>");
        std::fs::remove_dir_all(&dir).ok();
    }
}
