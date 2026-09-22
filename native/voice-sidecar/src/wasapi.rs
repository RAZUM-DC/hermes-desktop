// Direct WASAPI capture, because every abstraction above it failed on this
// hardware.
//
// The machine this was written for has an Intel Smart Sound Technology digital
// microphone array. Chromium inside Electron fails to open it
// (IAudioClient::Initialize -> E_INVALIDARG 0x80070057, surfacing in the
// renderer as "NotReadableError: Could not start audio source"), and so does
// cpal, for every format the driver advertises — yet Google Chrome records
// from the same device fine, and so does Windows' own Voice Recorder.
//
// What separates the working callers from the failing ones is not the format:
// it is IAudioClient2::SetClientProperties. Chrome marks the stream as
// AudioCategory_Communications without raw mode; Electron's Chromium marks it
// Communications *with* AUDCLNT_STREAMOPTIONS_RAW (it does that whenever it
// decides no audio processing is needed), and cpal never calls
// SetClientProperties at all. This driver evidently only accepts the first of
// those three.
//
// So instead of trusting any single recipe, we try a list of them — different
// stream categories, raw on/off, the driver's own mix format and explicit PCM
// formats with the engine's PCM converter enabled — and use the first that
// actually initializes. `--probe-audio` runs the whole list and prints the
// HRESULT for each, which is what identified the working combination in the
// first place.
//
// Windows-only by construction; the sidecar is only ever built for Windows.

use anyhow::{anyhow, bail, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use windows::core::{Interface, GUID};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, IAudioClient3, IMMDevice, AUDCLNT_SHAREMODE_EXCLUSIVE,
    DEVICE_STATE_ACTIVE, AudioCategory_Communications, AudioCategory_Other, AudioClientProperties,
    IAudioCaptureClient, IAudioClient, IAudioClient2, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMOPTIONS_NONE, AUDCLNT_STREAMOPTIONS_RAW, WAVEFORMATEX,
    WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT,
    COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED,
};

/// Let the audio engine convert PCM formats for us (docs: these two are used
/// together). Hardcoded rather than imported so the exact constant names in
/// the windows crate can't break the build.
const AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM: u32 = 0x8000_0000;
const AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY: u32 = 0x0800_0000;

const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

/// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT — 00000003-0000-0010-8000-00aa00389b71.
const SUBTYPE_IEEE_FLOAT: GUID = GUID::from_values(
    0x0000_0003,
    0x0000,
    0x0010,
    [0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71],
);

/// One way of asking the driver for a capture stream.
#[derive(Clone)]
struct Attempt {
    label: String,
    /// None = never call SetClientProperties (what cpal does).
    category: Option<Category>,
    raw: bool,
    format: FormatChoice,
    flags: u32,
    /// 0 = let the engine pick its default period.
    buffer_hns: i64,
    exclusive: bool,
    /// Initialize through IAudioClient3::InitializeSharedAudioStream instead —
    /// a different entry point into the driver stack.
    client3: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Category {
    Communications,
    Other,
}

#[derive(Clone, Copy)]
enum FormatChoice {
    /// Whatever GetMixFormat reports.
    Mix,
    /// An explicit integer PCM format; only sensible with AUTOCONVERTPCM.
    Pcm { channels: u16, rate: u32 },
}

fn base(label: String) -> Attempt {
    Attempt {
        label,
        category: None,
        raw: false,
        format: FormatChoice::Mix,
        flags: 0,
        buffer_hns: 0,
        exclusive: false,
        client3: false,
    }
}

/// Chromium passes this on input streams; worth sweeping since the format
/// itself has been cleared of suspicion (IsFormatSupported says yes, and
/// Initialize says E_INVALIDARG for that very format).
const AUDCLNT_STREAMFLAGS_NOPERSIST: u32 = 0x0008_0000;
const AUDCLNT_STREAMFLAGS_EVENTCALLBACK: u32 = 0x0004_0000;

const AUTOCONVERT: u32 =
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

/// Every recipe worth trying, most likely first.
fn attempts() -> Vec<Attempt> {
    let mut v = Vec::new();

    // Sweep the two parameters that are left once format is ruled out:
    // the stream flags and the buffer duration.
    for (flag_name, flags) in [
        ("flags=0", 0u32),
        ("NOPERSIST", AUDCLNT_STREAMFLAGS_NOPERSIST),
        (
            "EVENTCALLBACK|NOPERSIST",
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_NOPERSIST,
        ),
    ] {
        for (buf_name, buffer_hns) in [
            ("buf=0", 0i64),
            ("buf=10ms", 100_000),
            ("buf=100ms", 1_000_000),
            ("buf=1s", 10_000_000),
        ] {
            v.push(Attempt {
                flags,
                buffer_hns,
                ..base(format!("mix, {flag_name}, {buf_name}"))
            });
        }
    }

    // Stream categories, on the buffer size the engine itself suggests.
    for (cat_name, category, raw) in [
        ("category=Communications", Some(Category::Communications), false),
        ("category=Communications+RAW", Some(Category::Communications), true),
        ("category=Other", Some(Category::Other), false),
    ] {
        v.push(Attempt {
            category,
            raw,
            ..base(format!("mix, {cat_name}"))
        });
    }

    // Let the engine convert instead of matching its format.
    for (channels, rate) in [(1u16, 16_000u32), (1, 48_000), (2, 48_000)] {
        v.push(Attempt {
            format: FormatChoice::Pcm { channels, rate },
            flags: AUTOCONVERT,
            buffer_hns: 10_000_000,
            ..base(format!("{rate} Hz {channels}ch PCM, autoconvert"))
        });
    }

    // A different entry point into the same driver stack.
    v.push(Attempt {
        client3: true,
        ..base("IAudioClient3::InitializeSharedAudioStream, mix".into())
    });
    v.push(Attempt {
        client3: true,
        category: Some(Category::Communications),
        ..base("IAudioClient3::InitializeSharedAudioStream, Communications".into())
    });

    // Control experiment: exclusive mode bypasses the shared audio engine
    // entirely. If this one works, the engine/APO is what is broken.
    v.push(Attempt {
        exclusive: true,
        buffer_hns: 0, // filled in from GetDevicePeriod
        ..base("EXCLUSIVE mode, mix format, device period".into())
    });

    v
}

/// COM apartment models to try, in order.
///
/// This dimension exists because everything else was eliminated: on the
/// machine this was written for, every format and every stream category is
/// rejected by IAudioClient::Initialize with E_INVALIDARG, while Google Chrome
/// records from the same device at the same moment. Chrome runs its audio code
/// on a single-threaded-apartment COM thread; cpal, and the first version of
/// this file, both used MTA. Some driver APOs do behave differently between
/// the two, so the apartment is part of the matrix rather than an assumption.
const APARTMENTS: [(&str, COINIT); 2] = [
    ("STA", COINIT_APARTMENTTHREADED),
    ("MTA", COINIT_MULTITHREADED),
];

/// The format a stream actually ended up using, enough to decode its bytes.
#[derive(Clone, Copy, Debug)]
struct FormatInfo {
    channels: u16,
    rate: u32,
    bits: u16,
    is_float: bool,
}

impl FormatInfo {
    unsafe fn from_wave(format: *const WAVEFORMATEX) -> Self {
        // WAVEFORMATEX(TENSIBLE) is packed, so these are read out by value
        // rather than borrowed — a reference to a packed field is UB.
        let f = std::ptr::read_unaligned(format);
        let is_float = if f.wFormatTag == WAVE_FORMAT_EXTENSIBLE {
            let ext = std::ptr::read_unaligned(format as *const WAVEFORMATEXTENSIBLE);
            // Copied out by value: comparing in place would borrow a packed field.
            let subformat = ext.SubFormat;
            subformat == SUBTYPE_IEEE_FLOAT
        } else {
            f.wFormatTag == 3 // WAVE_FORMAT_IEEE_FLOAT
        };
        Self {
            channels: f.nChannels,
            rate: f.nSamplesPerSec,
            bits: f.wBitsPerSample,
            is_float,
        }
    }

    /// Interleaved device bytes -> mono f32 samples in [-1, 1].
    fn decode(&self, bytes: &[u8], out: &mut Vec<f32>) {
        let bytes_per_sample = (self.bits / 8).max(1) as usize;
        let channels = self.channels.max(1) as usize;
        let frame = bytes_per_sample * channels;
        if frame == 0 {
            return;
        }
        for chunk in bytes.chunks_exact(frame) {
            let mut acc = 0f32;
            for c in 0..channels {
                let s = &chunk[c * bytes_per_sample..(c + 1) * bytes_per_sample];
                acc += match (self.is_float, self.bits) {
                    (true, 32) => f32::from_le_bytes([s[0], s[1], s[2], s[3]]),
                    (false, 16) => i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0,
                    (false, 32) => {
                        i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f32 / 2_147_483_648.0
                    }
                    (false, 24) => {
                        let v = ((s[2] as i32) << 24 | (s[1] as i32) << 16 | (s[0] as i32) << 8) >> 8;
                        v as f32 / 8_388_608.0
                    }
                    (false, 8) => (s[0] as f32 - 128.0) / 128.0,
                    _ => 0.0,
                };
            }
            out.push(acc / channels as f32);
        }
    }
}

/// A WAVEFORMATEX for an explicit integer-PCM request.
fn pcm_format(channels: u16, rate: u32) -> WAVEFORMATEX {
    let bits = 16u16;
    let block_align = channels * bits / 8;
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM,
        nChannels: channels,
        nSamplesPerSec: rate,
        nAvgBytesPerSec: rate * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: bits,
        cbSize: 0,
    }
}

/// Activates a fresh client and runs one recipe. A failed Initialize poisons
/// the client, so every attempt gets its own.
unsafe fn try_attempt(
    enumerator: &IMMDeviceEnumerator,
    attempt: &Attempt,
) -> Result<(IAudioClient, FormatInfo)> {
    let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole)?;
    try_attempt_on(&device, attempt)
}

/// Runs one recipe against an endpoint the caller already has. Each step is
/// labelled so a failure says which COM call rejected us, not just that one did.
unsafe fn try_attempt_on(
    device: &IMMDevice,
    attempt: &Attempt,
) -> Result<(IAudioClient, FormatInfo)> {
    let client: IAudioClient = device
        .Activate(CLSCTX_ALL, None)
        .map_err(|e| anyhow!("Activate: {e}"))?;

    if let Some(category) = attempt.category {
        let client2: IAudioClient2 = client
            .cast()
            .map_err(|e| anyhow!("cast to IAudioClient2: {e}"))?;
        let props = AudioClientProperties {
            cbSize: std::mem::size_of::<AudioClientProperties>() as u32,
            bIsOffload: false.into(),
            eCategory: match category {
                Category::Communications => AudioCategory_Communications,
                Category::Other => AudioCategory_Other,
            },
            Options: if attempt.raw {
                AUDCLNT_STREAMOPTIONS_RAW
            } else {
                AUDCLNT_STREAMOPTIONS_NONE
            },
        };
        client2
            .SetClientProperties(&props)
            .map_err(|e| anyhow!("SetClientProperties: {e}"))?;
    }

    let mix = client
        .GetMixFormat()
        .map_err(|e| anyhow!("GetMixFormat: {e}"))?;
    let (format_ptr, info) = match attempt.format {
        FormatChoice::Mix => (mix as *const WAVEFORMATEX, FormatInfo::from_wave(mix)),
        FormatChoice::Pcm { channels, rate } => {
            let wf = Box::leak(Box::new(pcm_format(channels, rate)));
            let ptr: *const WAVEFORMATEX = wf;
            (ptr, FormatInfo::from_wave(ptr))
        }
    };

    if attempt.client3 {
        let client3: IAudioClient3 = client
            .cast()
            .map_err(|e| anyhow!("cast to IAudioClient3: {e}"))?;
        let mut default_frames = 0u32;
        let mut fundamental = 0u32;
        let mut min_frames = 0u32;
        let mut max_frames = 0u32;
        client3
            .GetSharedModeEnginePeriod(
                format_ptr,
                &mut default_frames,
                &mut fundamental,
                &mut min_frames,
                &mut max_frames,
            )
            .map_err(|e| anyhow!("GetSharedModeEnginePeriod: {e}"))?;
        client3
            .InitializeSharedAudioStream(attempt.flags, default_frames, format_ptr, None)
            .map_err(|e| {
                anyhow!("InitializeSharedAudioStream(period={default_frames} frames): {e}")
            })?;
        return Ok((client, info));
    }

    let (share_mode, buffer_hns) = if attempt.exclusive {
        let mut default_period = 0i64;
        let mut min_period = 0i64;
        client
            .GetDevicePeriod(Some(&mut default_period), Some(&mut min_period))
            .map_err(|e| anyhow!("GetDevicePeriod: {e}"))?;
        (AUDCLNT_SHAREMODE_EXCLUSIVE, default_period)
    } else {
        (AUDCLNT_SHAREMODE_SHARED, attempt.buffer_hns)
    };

    client
        .Initialize(share_mode, attempt.flags, buffer_hns, 0, format_ptr, None)
        .map_err(|e| anyhow!("Initialize: {e}"))?;
    Ok((client, info))
}

pub struct Capture {
    buffer: Arc<Mutex<Vec<f32>>>,
    stopping: Arc<AtomicBool>,
    src_rate: u32,
    description: String,
}

impl Capture {
    /// Opens the first recipe that works and records into an in-memory buffer
    /// until `stop()`. Started before the model loads, so nothing said in the
    /// first second is lost.
    pub fn start() -> Result<Self> {
        let buffer = Arc::new(Mutex::new(Vec::<f32>::new()));
        let stopping = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<std::result::Result<(u32, String), String>>();

        let thread_buffer = buffer.clone();
        let thread_stopping = stopping.clone();
        thread::Builder::new()
            .name("wasapi-capture".into())
            .spawn(move || capture_thread(thread_buffer, thread_stopping, tx))?;

        match rx.recv() {
            Ok(Ok((src_rate, description))) => Ok(Self {
                buffer,
                stopping,
                src_rate,
                description,
            }),
            Ok(Err(e)) => Err(anyhow!(e)),
            Err(_) => bail!("the capture thread died before reporting"),
        }
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    /// Everything captured so far, as 16 kHz mono — safe to call repeatedly
    /// while still recording (that is how interim results are produced).
    pub fn samples_16k(&self) -> Vec<f32> {
        let raw = match self.buffer.lock() {
            Ok(b) => b.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        };
        crate::capture::resample(&raw, self.src_rate, crate::capture::TARGET_RATE)
    }

    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop();
    }
}

fn capture_thread(
    buffer: Arc<Mutex<Vec<f32>>>,
    stopping: Arc<AtomicBool>,
    tx: mpsc::Sender<std::result::Result<(u32, String), String>>,
) {
    unsafe {
        let mut failures = Vec::new();
        let mut opened = None;
        let mut apartment_used = "";

        for (apartment, mode) in APARTMENTS {
            let _ = CoInitializeEx(None, mode);
            let enumerator: IMMDeviceEnumerator =
                match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                    Ok(e) => e,
                    Err(e) => {
                        failures.push(format!("[{apartment}] no endpoint enumerator: {e}"));
                        CoUninitialize();
                        continue;
                    }
                };
            for attempt in &attempts() {
                match try_attempt(&enumerator, attempt) {
                    Ok((client, info)) => {
                        opened = Some((client, info, attempt.label.clone()));
                        apartment_used = apartment;
                        break;
                    }
                    Err(e) => failures.push(format!("[{apartment}] {} -> {e}", attempt.label)),
                }
            }
            if opened.is_some() {
                break;
            }
            // Nothing worked in this apartment; leave it before trying the next.
            CoUninitialize();
        }

        let (client, info, label) = match opened {
            Some(v) => v,
            None => {
                // Modern path exhausted — hand over to WinMM, which reaches the
                // device through the compatibility layer instead.
                eprintln!(
                    "[voice-sidecar] WASAPI rejected all {} recipe(s); falling back to waveIn",
                    failures.len()
                );
                for failure in &failures {
                    eprintln!("[voice-sidecar]   {failure}");
                }
                crate::winmm::capture_thread(buffer, stopping, tx);
                return;
            }
        };

        let capture_client: IAudioCaptureClient = match client.GetService() {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(Err(format!("no capture service: {e}")));
                return;
            }
        };
        if let Err(e) = client.Start() {
            let _ = tx.send(Err(format!("the capture stream would not start: {e}")));
            return;
        }

        let description = format!(
            "{label} [{apartment_used}, {} ch, {} Hz, {} bit{}]",
            info.channels,
            info.rate,
            info.bits,
            if info.is_float { " float" } else { "" }
        );
        if !failures.is_empty() {
            eprintln!(
                "[voice-sidecar] {} recipe(s) rejected before this one",
                failures.len()
            );
        }
        let _ = tx.send(Ok((info.rate, description)));

        // Poll rather than wait on an event: a 10 ms tick is far below the
        // buffer size we asked for, and it keeps the whole thing to one thread.
        let mut decoded = Vec::new();
        while !stopping.load(Ordering::SeqCst) {
            loop {
                let packet = match capture_client.GetNextPacketSize() {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("[voice-sidecar] capture error: {e}");
                        break;
                    }
                };
                if packet == 0 {
                    break;
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames: u32 = 0;
                let mut flags: u32 = 0;
                if capture_client
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                    .is_err()
                {
                    break;
                }
                if frames > 0 && !data.is_null() {
                    let bytes = frames as usize
                        * (info.bits / 8).max(1) as usize
                        * info.channels.max(1) as usize;
                    decoded.clear();
                    // AUDCLNT_BUFFERFLAGS_SILENT (0x2): the buffer is garbage
                    // and must be treated as silence.
                    if flags & 0x2 != 0 {
                        decoded.resize(frames as usize, 0.0);
                    } else {
                        info.decode(std::slice::from_raw_parts(data, bytes), &mut decoded);
                    }
                    if let Ok(mut b) = buffer.lock() {
                        b.extend_from_slice(&decoded);
                    }
                }
                let _ = capture_client.ReleaseBuffer(frames);
            }
            thread::sleep(Duration::from_millis(10));
        }
        let _ = client.Stop();
    }
}

/// --probe-audio: walk every apartment model, every capture endpoint and every
/// step of opening it, printing exactly which call fails and with which
/// HRESULT.
pub fn probe() -> Result<()> {
    for (apartment, mode) in APARTMENTS {
        println!("\n=== COM apartment: {apartment} ===");
        // A thread can only be in one apartment for its lifetime, so each pass
        // gets a fresh one.
        let handle = thread::spawn(move || unsafe { probe_apartment(mode) });
        match handle.join() {
            Ok(Ok(())) => {}
            Ok(Err(e)) => println!("  probe failed: {e}"),
            Err(_) => println!("  probe thread panicked"),
        }
    }
    Ok(())
}

unsafe fn probe_apartment(mode: COINIT) -> Result<()> {
    let _ = CoInitializeEx(None, mode);
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;

    let collection = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)?;
    let count = collection.GetCount()?;
    println!("{count} active capture endpoint(s)");

    for index in 0..count {
        let device = match collection.Item(index) {
            Ok(d) => d,
            Err(e) => {
                println!("[{index}] Item() failed: {e}");
                continue;
            }
        };
        let id = device
            .GetId()
            .ok()
            .and_then(|p| p.to_string().ok())
            .unwrap_or_else(|| "<no id>".into());
        println!("\n[{index}] {id}");

        let client: IAudioClient = match device.Activate(CLSCTX_ALL, None) {
            Ok(c) => c,
            Err(e) => {
                println!("      Activate(IAudioClient)      FAIL {e}");
                continue;
            }
        };
        println!("      Activate(IAudioClient)      OK");

        let mut default_period: i64 = 0;
        let mut min_period: i64 = 0;
        match client.GetDevicePeriod(Some(&mut default_period), Some(&mut min_period)) {
            Ok(()) => println!(
                "      GetDevicePeriod             OK default={default_period} min={min_period} (100ns)"
            ),
            Err(e) => println!("      GetDevicePeriod             FAIL {e}"),
        }

        match client.GetMixFormat() {
            Ok(m) => {
                let f = std::ptr::read_unaligned(m);
                let (tag, ch, rate, bits, cb) = (
                    f.wFormatTag,
                    f.nChannels,
                    f.nSamplesPerSec,
                    f.wBitsPerSample,
                    f.cbSize,
                );
                println!(
                    "      GetMixFormat                OK tag={tag} ch={ch} rate={rate} bits={bits} cbSize={cb}"
                );
                // ppClosestMatch is mandatory in shared mode — passing None is
                // what made this report E_POINTER the first time round.
                let mut closest: *mut WAVEFORMATEX = std::ptr::null_mut();
                let hr = client.IsFormatSupported(AUDCLNT_SHAREMODE_SHARED, m, Some(&mut closest));
                if hr.is_ok() {
                    println!("      IsFormatSupported(mix)      OK");
                } else if !closest.is_null() {
                    let c = std::ptr::read_unaligned(closest);
                    let (ctag, cch, crate_, cbits) =
                        (c.wFormatTag, c.nChannels, c.nSamplesPerSec, c.wBitsPerSample);
                    println!(
                        "      IsFormatSupported(mix)      {hr:?}, closest: tag={ctag} ch={cch} rate={crate_} bits={cbits}"
                    );
                } else {
                    println!("      IsFormatSupported(mix)      {hr:?}, no closest match offered");
                }
            }
            Err(e) => println!("      GetMixFormat                FAIL {e}"),
        }

        for attempt in &attempts() {
            match try_attempt_on(&device, attempt) {
                Ok(_) => println!("      OK    {}", attempt.label),
                Err(e) => println!("      FAIL  {} -> {e}", attempt.label),
            }
        }
    }

    println!("\n--- legacy WinMM (waveIn) path ---");
    let _ = crate::winmm::probe();
    Ok(())
}
