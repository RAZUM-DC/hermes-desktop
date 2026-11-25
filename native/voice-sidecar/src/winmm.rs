// Capture through WinMM (waveIn) — the legacy path into the audio stack.
//
// This exists because the modern path is comprehensively broken on the machine
// this was written for: IAudioClient::Initialize rejects every shared-mode
// request with E_INVALIDARG — the driver's own mix format (which it approves
// in IsFormatSupported a line earlier), explicit PCM with the engine's
// converter, every stream category, every buffer size, both COM apartments,
// and IAudioClient3's own suggested period. Exclusive mode answers with a
// different error (AUDCLNT_E_UNSUPPORTED_FORMAT), so the endpoint is reachable
// — it is shared-mode initialization specifically that fails.
//
// waveIn goes through the WinMM compatibility layer rather than a direct
// IAudioClient of our own, and it lets the system pick the conversion, so it
// can succeed where the modern API does not. It is also exactly what Chromium
// used to expose as --force-wave-audio for this class of driver.
//
// Bonus: we can ask for 16 kHz mono outright and let Windows convert, which is
// what Whisper wants anyway — no resampling on our side at all.

use anyhow::{anyhow, bail, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use windows::Win32::Media::Audio::{
    waveInAddBuffer, waveInClose, waveInGetNumDevs, waveInOpen, waveInPrepareHeader, waveInReset,
    waveInStart, waveInStop, waveInUnprepareHeader, HWAVEIN, MIDI_WAVE_OPEN_TYPE, WAVEFORMATEX,
    WAVEHDR, WAVE_MAPPER,
};

const MMSYSERR_NOERROR: u32 = 0;
/// CALLBACK_NULL: no callback, we poll the headers instead.
const CALLBACK_NULL: MIDI_WAVE_OPEN_TYPE = MIDI_WAVE_OPEN_TYPE(0);
const WHDR_DONE: u32 = 0x0000_0001;

/// Eight 100 ms buffers: enough slack that a late poll never drops audio.
const BUFFER_COUNT: usize = 8;
const BUFFER_MS: u32 = 100;

/// Formats to ask for, best first. 16 kHz mono is what Whisper needs.
const FORMATS: [(u16, u32); 4] = [(1, 16_000), (1, 48_000), (1, 44_100), (2, 48_000)];

fn pcm_format(channels: u16, rate: u32) -> WAVEFORMATEX {
    let bits = 16u16;
    let block_align = channels * bits / 8;
    WAVEFORMATEX {
        wFormatTag: 1, // WAVE_FORMAT_PCM
        nChannels: channels,
        nSamplesPerSec: rate,
        nAvgBytesPerSec: rate * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: bits,
        cbSize: 0,
    }
}

fn mm_error(code: u32) -> String {
    match code {
        1 => "MMSYSERR_ERROR".into(),
        2 => "MMSYSERR_BADDEVICEID".into(),
        4 => "MMSYSERR_ALLOCATED (device already in use)".into(),
        5 => "MMSYSERR_INVALHANDLE".into(),
        7 => "MMSYSERR_NOMEM".into(),
        32 => "WAVERR_BADFORMAT (format not supported)".into(),
        33 => "WAVERR_STILLPLAYING".into(),
        34 => "WAVERR_UNPREPARED".into(),
        other => format!("MMRESULT {other}"),
    }
}

/// An open waveIn device with its buffers pinned in place.
struct WaveIn {
    handle: HWAVEIN,
    headers: Vec<Box<WAVEHDR>>,
    _buffers: Vec<Box<[u8]>>,
    channels: u16,
    rate: u32,
}

impl WaveIn {
    unsafe fn open(channels: u16, rate: u32) -> Result<Self> {
        let format = pcm_format(channels, rate);
        let mut handle = HWAVEIN::default();
        let rc = waveInOpen(
            Some(&mut handle),
            WAVE_MAPPER,
            &format,
            0,
            0,
            CALLBACK_NULL,
        );
        if rc != MMSYSERR_NOERROR {
            bail!("waveInOpen({rate} Hz, {channels} ch): {}", mm_error(rc));
        }

        let bytes = (format.nAvgBytesPerSec * BUFFER_MS / 1000) as usize;
        let mut buffers = Vec::with_capacity(BUFFER_COUNT);
        let mut headers: Vec<Box<WAVEHDR>> = Vec::with_capacity(BUFFER_COUNT);
        for _ in 0..BUFFER_COUNT {
            let mut buf: Box<[u8]> = vec![0u8; bytes].into_boxed_slice();
            let mut header = Box::new(WAVEHDR {
                lpData: windows::core::PSTR(buf.as_mut_ptr()),
                dwBufferLength: bytes as u32,
                ..Default::default()
            });
            let rc = waveInPrepareHeader(
                handle,
                header.as_mut(),
                std::mem::size_of::<WAVEHDR>() as u32,
            );
            if rc != MMSYSERR_NOERROR {
                let _ = waveInClose(handle);
                bail!("waveInPrepareHeader: {}", mm_error(rc));
            }
            let rc = waveInAddBuffer(
                handle,
                header.as_mut(),
                std::mem::size_of::<WAVEHDR>() as u32,
            );
            if rc != MMSYSERR_NOERROR {
                let _ = waveInClose(handle);
                bail!("waveInAddBuffer: {}", mm_error(rc));
            }
            buffers.push(buf);
            headers.push(header);
        }

        let rc = waveInStart(handle);
        if rc != MMSYSERR_NOERROR {
            let _ = waveInClose(handle);
            bail!("waveInStart: {}", mm_error(rc));
        }

        Ok(Self {
            handle,
            headers,
            _buffers: buffers,
            channels,
            rate,
        })
    }

    unsafe fn close(&mut self) {
        let _ = waveInStop(self.handle);
        let _ = waveInReset(self.handle);
        for header in &mut self.headers {
            let _ = waveInUnprepareHeader(
                self.handle,
                header.as_mut(),
                std::mem::size_of::<WAVEHDR>() as u32,
            );
        }
        let _ = waveInClose(self.handle);
    }
}

/// Interleaved 16-bit PCM -> mono f32 in [-1, 1].
fn decode(bytes: &[u8], channels: usize, out: &mut Vec<f32>) {
    let frame = 2 * channels.max(1);
    for chunk in bytes.chunks_exact(frame) {
        let mut acc = 0f32;
        for c in 0..channels.max(1) {
            let s = i16::from_le_bytes([chunk[c * 2], chunk[c * 2 + 1]]);
            acc += s as f32 / 32768.0;
        }
        out.push(acc / channels.max(1) as f32);
    }
}

/// Runs the capture loop until `stopping`, reporting the opened format (or the
/// reason nothing opened) through `tx`. Meant to be the body of its own thread.
pub fn capture_thread(
    buffer: Arc<Mutex<Vec<f32>>>,
    stopping: Arc<AtomicBool>,
    tx: mpsc::Sender<std::result::Result<(u32, String), String>>,
) {
    unsafe {
        if waveInGetNumDevs() == 0 {
            let _ = tx.send(Err("waveIn reports no input devices".into()));
            return;
        }

        let mut failures = Vec::new();
        let mut device = None;
        for (channels, rate) in FORMATS {
            match WaveIn::open(channels, rate) {
                Ok(d) => {
                    device = Some(d);
                    break;
                }
                Err(e) => failures.push(format!("{e}")),
            }
        }
        let mut device = match device {
            Some(d) => d,
            None => {
                let _ = tx.send(Err(format!(
                    "waveIn refused every format:\n  {}",
                    failures.join("\n  ")
                )));
                return;
            }
        };

        let description = format!(
            "waveIn [{} ch, {} Hz, 16 bit]",
            device.channels, device.rate
        );
        let _ = tx.send(Ok((device.rate, description)));

        let channels = device.channels as usize;
        let mut decoded = Vec::new();
        while !stopping.load(Ordering::SeqCst) {
            let mut did_work = false;
            for header in &mut device.headers {
                if header.dwFlags & WHDR_DONE == 0 {
                    continue;
                }
                did_work = true;
                let recorded = header.dwBytesRecorded as usize;
                if recorded > 0 {
                    let data = std::slice::from_raw_parts(header.lpData.0, recorded);
                    decoded.clear();
                    decode(data, channels, &mut decoded);
                    if let Ok(mut b) = buffer.lock() {
                        b.extend_from_slice(&decoded);
                    }
                }
                header.dwBytesRecorded = 0;
                header.dwFlags &= !WHDR_DONE;
                let rc = waveInAddBuffer(
                    device.handle,
                    header.as_mut(),
                    std::mem::size_of::<WAVEHDR>() as u32,
                );
                if rc != MMSYSERR_NOERROR {
                    eprintln!("[voice-sidecar] waveInAddBuffer: {}", mm_error(rc));
                }
            }
            if !did_work {
                thread::sleep(Duration::from_millis(10));
            }
        }
        device.close();
    }
}

/// Part of --probe-audio: report what waveIn makes of this machine.
pub fn probe() -> Result<()> {
    unsafe {
        let devices = waveInGetNumDevs();
        println!("waveInGetNumDevs = {devices}");
        if devices == 0 {
            return Ok(());
        }
        for (channels, rate) in FORMATS {
            match WaveIn::open(channels, rate) {
                Ok(mut d) => {
                    println!("  OK    waveIn {rate} Hz, {channels} ch, 16 bit");
                    d.close();
                }
                Err(e) => println!("  FAIL  waveIn {rate} Hz, {channels} ch -> {e}"),
            }
        }
    }
    Ok(())
}

/// Opened once at startup to prove the device is usable before the model loads.
pub fn is_available() -> bool {
    unsafe { waveInGetNumDevs() > 0 }
}

#[allow(dead_code)]
fn unused() -> Result<()> {
    Err(anyhow!("never called"))
}
