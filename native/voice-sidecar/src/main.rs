// hermes-voice-sidecar: local, offline speech-to-text for the РАЗУМ desktop
// mic button.
//
// Adapted from candle's whisper example (huggingface/candle,
// candle-examples/examples/whisper/main.rs — Apache-2.0 / MIT dual licensed,
// same as the rest of the candle project) and trimmed down to what the
// desktop app actually needs:
//   - no timestamp mode (dictation snippets are short and we only want the
//     plain transcript, so the whole apply_timestamp_rules() token-masking
//     machinery from the original example is dropped)
//   - no CLI-selectable model zoo: always the quantized multilingual "tiny"
//     model (lmz/candle-whisper), fixed language (default "ru", overridable)
//   - reads 16 kHz mono PCM as a WAV file from stdin instead of a path, so
//     the Electron main process can pipe the already-decoded recording in
//     directly (decoding the MediaRecorder blob to 16 kHz mono happens in
//     the renderer via the Web Audio API — see decodeToWav16kMono in
//     useVoiceInput.ts — so this binary never has to deal with WebM/Opus).
//   - one JSON object on stdout: {"text": "..."} on success, or
//     {"error": "..."} (and a non-zero exit code) on failure.
//
// The model is fetched on first use via hf-hub and cached under HF_HOME
// (the Electron side points this at a Hermes-owned folder — see
// voice-sidecar.ts) so later runs are fully offline.

use anyhow::{bail, Context, Error as E, Result};
use candle_core::{Device, IndexOp, Tensor};
use candle_nn::ops::softmax;
use candle_transformers::models::whisper::{self as m, audio, quantized_model, Config};
use clap::Parser;
use rand::distr::weighted::WeightedIndex;
use rand::distr::Distribution;
use rand::SeedableRng;
use std::io::{self, BufRead, Read, Write};
use tokenizers::Tokenizer;

mod capture;
mod wasapi;
mod winmm;

#[derive(Parser, Debug)]
#[command(author, version, about = "Local speech-to-text for РАЗУМ Ассистент")]
struct Args {
    /// BCP-47-ish language code Whisper understands (ru, en, ...).
    #[arg(long, default_value = "ru")]
    language: String,

    /// Capture from the microphone ourselves (WASAPI shared mode via cpal)
    /// instead of receiving a WAV on stdin. Driven by line commands on stdin:
    /// `partial` for an interim transcript, `stop` to finish.
    #[arg(long)]
    record: bool,

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

fn token_id(tokenizer: &Tokenizer, token: &str) -> Result<u32> {
    tokenizer
        .token_to_id(token)
        .with_context(|| format!("no token-id for {token}"))
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

struct Decoder {
    model: quantized_model::Whisper,
    rng: rand::rngs::StdRng,
    tokenizer: Tokenizer,
    suppress_tokens: Tensor,
    sot_token: u32,
    transcribe_token: u32,
    eot_token: u32,
    no_speech_token: u32,
    no_timestamps_token: u32,
    language_token: u32,
}

#[derive(Debug, Clone)]
struct DecodingResult {
    tokens: Vec<u32>,
    text: String,
    avg_logprob: f64,
    no_speech_prob: f64,
    compression_ratio: f64,
}

impl Decoder {
    fn new(
        model: quantized_model::Whisper,
        tokenizer: Tokenizer,
        device: &Device,
        language_token: u32,
    ) -> Result<Self> {
        let no_timestamps_token = token_id(&tokenizer, m::NO_TIMESTAMPS_TOKEN)?;
        // We never emit timestamps, so always suppress that token family the
        // same way the upstream example does when timestamps are off.
        let suppress_tokens: Vec<f32> = (0..model.config.vocab_size as u32)
            .map(|i| {
                if model.config.suppress_tokens.contains(&i) || i == no_timestamps_token {
                    f32::NEG_INFINITY
                } else {
                    0f32
                }
            })
            .collect();
        let suppress_tokens = Tensor::new(suppress_tokens.as_slice(), device)?;
        let sot_token = token_id(&tokenizer, m::SOT_TOKEN)?;
        let transcribe_token = token_id(&tokenizer, m::TRANSCRIBE_TOKEN)?;
        let eot_token = token_id(&tokenizer, m::EOT_TOKEN)?;
        let no_speech_token = m::NO_SPEECH_TOKENS
            .iter()
            .find_map(|token| token_id(&tokenizer, token).ok())
            .context("unable to find any non-speech token")?;
        Ok(Self {
            model,
            rng: rand::rngs::StdRng::seed_from_u64(299792458),
            tokenizer,
            suppress_tokens,
            sot_token,
            transcribe_token,
            eot_token,
            no_speech_token,
            no_timestamps_token,
            language_token,
        })
    }

    fn decode(&mut self, mel: &Tensor, t: f64) -> Result<DecodingResult> {
        let audio_features = self.model.encoder.forward(mel, true)?;
        let sample_len = self.model.config.max_target_positions / 2;
        let mut sum_logprob = 0f64;
        let mut no_speech_prob = f64::NAN;
        let mut tokens = vec![self.sot_token, self.language_token, self.transcribe_token];
        tokens.push(self.no_timestamps_token);
        for i in 0..sample_len {
            let tokens_t = Tensor::new(tokens.as_slice(), mel.device())?.unsqueeze(0)?;
            let ys = self
                .model
                .decoder
                .forward(&tokens_t, &audio_features, i == 0)?;
            if i == 0 {
                let logits = self.model.decoder.final_linear(&ys.i(..1)?)?.i(0)?.i(0)?;
                no_speech_prob = softmax(&logits, 0)?
                    .i(self.no_speech_token as usize)?
                    .to_scalar::<f32>()? as f64;
            }
            let (_, seq_len, _) = ys.dims3()?;
            let logits = self
                .model
                .decoder
                .final_linear(&ys.i((..1, seq_len - 1..))?)?
                .i(0)?
                .i(0)?;
            let logits = logits.broadcast_add(&self.suppress_tokens)?;
            let next_token = if t > 0f64 {
                let prs = softmax(&(&logits / t)?, 0)?;
                let logits_v: Vec<f32> = prs.to_vec1()?;
                WeightedIndex::new(&logits_v)?.sample(&mut self.rng) as u32
            } else {
                let logits_v: Vec<f32> = logits.to_vec1()?;
                logits_v
                    .iter()
                    .enumerate()
                    .max_by(|(_, u), (_, v)| u.total_cmp(v))
                    .map(|(i, _)| i as u32)
                    .unwrap()
            };
            tokens.push(next_token);
            let prob = softmax(&logits, candle_core::D::Minus1)?
                .i(next_token as usize)?
                .to_scalar::<f32>()? as f64;
            if next_token == self.eot_token || tokens.len() > self.model.config.max_target_positions
            {
                break;
            }
            sum_logprob += prob.ln();
        }
        let text = self.tokenizer.decode(&tokens, true).map_err(E::msg)?;
        let avg_logprob = sum_logprob / tokens.len() as f64;
        Ok(DecodingResult {
            tokens,
            text,
            avg_logprob,
            no_speech_prob,
            compression_ratio: f64::NAN,
        })
    }

    fn decode_with_fallback(&mut self, segment: &Tensor) -> Result<DecodingResult> {
        for (i, &t) in m::TEMPERATURES.iter().enumerate() {
            let dr = self.decode(segment, t);
            if i == m::TEMPERATURES.len() - 1 {
                return dr;
            }
            match dr {
                Ok(dr) => {
                    let needs_fallback = dr.compression_ratio > m::COMPRESSION_RATIO_THRESHOLD
                        || dr.avg_logprob < m::LOGPROB_THRESHOLD;
                    if !needs_fallback || dr.no_speech_prob > m::NO_SPEECH_THRESHOLD {
                        return Ok(dr);
                    }
                }
                Err(_) => continue,
            }
        }
        unreachable!()
    }

    /// Transcribe the whole (possibly multi-segment) mel spectrogram and
    /// return the concatenated plain-text transcript.
    fn run(&mut self, mel: &Tensor) -> Result<String> {
        let (_, _, content_frames) = mel.dims3()?;
        let mut seek = 0;
        let mut text = String::new();
        while seek < content_frames {
            let segment_size = usize::min(content_frames - seek, m::N_FRAMES);
            let mel_segment = mel.narrow(2, seek, segment_size)?;
            let dr = self.decode_with_fallback(&mel_segment)?;
            seek += segment_size;
            if dr.no_speech_prob > m::NO_SPEECH_THRESHOLD && dr.avg_logprob < m::LOGPROB_THRESHOLD {
                continue; // silence — skip, matches upstream's "no speech detected"
            }
            if !text.is_empty() && !dr.text.is_empty() {
                text.push(' ');
            }
            text.push_str(dr.text.trim());
        }
        Ok(text)
    }
}

const MODEL_REPO: &str = "lmz/candle-whisper";
const MODEL_FILES: [&str; 3] = [
    "config-tiny.json",
    "tokenizer-tiny.json",
    "model-tiny-q80.gguf",
];

fn cache_dir() -> Result<std::path::PathBuf> {
    // The Electron side points this at a Hermes-owned folder (see
    // voice-sidecar.ts) so the cache lives next to the rest of the app's
    // data instead of some ambient HF cache the user never asked for.
    let dir = match std::env::var_os("HERMES_VOICE_MODEL_DIR") {
        Some(dir) => std::path::PathBuf::from(dir),
        None => std::env::temp_dir().join("hermes-voice-model-cache"),
    };
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Download the three model files into the cache dir if they aren't there
/// yet, and return their local paths. A plain blocking `ureq` GET rather
/// than pulling in hf-hub's async/reqwest/aws-lc-rs stack, which is a lot
/// of native crypto code to cross-compile for very little benefit here —
/// three fixed files over HTTPS is all we ever need.
fn model_files() -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf)> {
    let dir = cache_dir()?;
    let mut paths = Vec::with_capacity(3);
    for name in MODEL_FILES {
        let path = dir.join(name);
        if !path.exists() {
            let url = format!("https://huggingface.co/{MODEL_REPO}/resolve/main/{name}");
            eprintln!("[voice-sidecar] downloading {name}...");
            let mut response = ureq::get(&url)
                .call()
                .with_context(|| format!("downloading {url}"))?;
            let mut body = response.body_mut().as_reader();
            let tmp = dir.join(format!("{name}.part"));
            {
                let mut f = std::fs::File::create(&tmp)?;
                io::copy(&mut body, &mut f)?;
            }
            std::fs::rename(&tmp, &path)?;
        }
        paths.push(path);
    }
    Ok((paths[0].clone(), paths[1].clone(), paths[2].clone()))
}

/// Everything the sidecar needs to turn PCM into text, loaded once.
///
/// Split out of `run()` because the --record path transcribes repeatedly
/// (interim results while the user is still speaking, then a final pass),
/// and reloading a 40 MB quantized model per tick would be absurd.
struct Pipeline {
    config: Config,
    mel_filters: Vec<f32>,
    decoder: Decoder,
}

impl Pipeline {
    fn load(args: &Args) -> Result<Self> {
        let device = Device::Cpu;
        let (config_path, tokenizer_path, weights_path) = model_files()
            .context("fetching/locating the Whisper model (needs network on first run)")?;

        // Parsed twice rather than cloned: candle's Config is consumed by
        // Whisper::load, and we need our own copy for pcm_to_mel later.
        let config_json = std::fs::read_to_string(config_path)?;
        let config: Config = serde_json::from_str(&config_json)?;
        let model_config: Config = serde_json::from_str(&config_json)?;

        let tokenizer = Tokenizer::from_file(tokenizer_path).map_err(E::msg)?;
        let language_token = token_id(&tokenizer, &format!("<|{}|>", args.language))
            .with_context(|| format!("language '{}' is not supported", args.language))?;

        let mel_bytes = include_bytes!("melfilters.bytes").as_slice();
        let mut mel_filters = vec![0f32; mel_bytes.len() / 4];
        <byteorder::LittleEndian as byteorder::ByteOrder>::read_f32_into(
            mel_bytes,
            &mut mel_filters,
        );

        let vb = candle_transformers::quantized_var_builder::VarBuilder::from_gguf(
            &weights_path,
            &device,
        )?;
        let model = quantized_model::Whisper::load(&vb, model_config)?;
        let decoder = Decoder::new(model, tokenizer, &device, language_token)?;

        Ok(Self {
            config,
            mel_filters,
            decoder,
        })
    }

    fn transcribe(&mut self, pcm: &[f32]) -> Result<String> {
        // Anything shorter than ~200 ms is a button tap, not speech; running
        // it through the model only produces hallucinated filler.
        if pcm.len() < m::SAMPLE_RATE / 5 {
            return Ok(String::new());
        }
        let mel = audio::pcm_to_mel(&self.config, pcm, &self.mel_filters);
        let mel_len = mel.len();
        let mel = Tensor::from_vec(
            mel,
            (1, self.config.num_mel_bins, mel_len / self.config.num_mel_bins),
            &Device::Cpu,
        )?;
        self.decoder.run(&mel)
    }
}

/// --record: we own the microphone, not Chromium.
///
/// Capture starts before the model is loaded so the beginning of the phrase
/// is never clipped. Afterwards the caller drives us over stdin, one command
/// per line:
///   partial -> transcribe what has been captured so far, emit {"partial": "..."}
///   stop    -> stop capturing, transcribe everything, emit {"text": "..."} and exit
/// stdin closing counts as `stop`, so a crashed parent can't leave the
/// microphone open.
fn record(args: &Args) -> Result<String> {
    let capture = wasapi::Capture::start().context("opening the microphone")?;
    emit(&serde_json::json!({ "status": "recording" }));
    eprintln!(
        "[voice-sidecar] capturing from {} -> {} Hz",
        capture.description(),
        capture::TARGET_RATE
    );

    let mut pipeline = Pipeline::load(args)?;
    emit(&serde_json::json!({ "status": "ready" }));

    let stdin = io::stdin();
    loop {
        let mut line = String::new();
        if stdin.lock().read_line(&mut line)? == 0 {
            break; // parent went away
        }
        match line.trim() {
            "partial" => {
                let text = pipeline.transcribe(&capture.samples_16k()).unwrap_or_default();
                emit(&serde_json::json!({ "partial": text }));
            }
            "stop" => break,
            "" => {}
            other => eprintln!("[voice-sidecar] ignoring unknown command: {other}"),
        }
    }

    capture.stop();
    pipeline.transcribe(&capture.samples_16k())
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
        model_files()
            .context("fetching/locating the Whisper model (needs network on first run)")?;
        eprintln!("[voice-sidecar] model cached, ready for offline use");
        return Ok(None);
    }

    if args.probe_audio {
        wasapi::probe()?;
        return Ok(None);
    }

    if args.record {
        return record(args).map(Some);
    }

    // Legacy path: an already-decoded 16 kHz mono WAV piped in on stdin.
    // Kept so the renderer's MediaRecorder fallback still has somewhere to go
    // on machines where getUserMedia works fine.
    let mut pipeline = Pipeline::load(args)?;
    let (pcm_data, sample_rate) =
        read_wav(io::stdin().lock()).context("reading WAV audio from stdin")?;
    if sample_rate != m::SAMPLE_RATE as u32 {
        bail!(
            "expected {} Hz audio on stdin, got {} Hz",
            m::SAMPLE_RATE,
            sample_rate
        );
    }
    Ok(Some(pipeline.transcribe(&pcm_data)?))
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
