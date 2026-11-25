import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../../components/useI18n";

/**
 * Voice input for the chat box.
 *
 * Primary path: the browser SpeechRecognition API, which streams results live
 * as the user speaks. Fallback (when SpeechRecognition is missing or fails —
 * the norm in Electron's Chromium, which has no speech backend): record with
 * MediaRecorder and transcribe via the active profile's provider (Groq/OpenAI
 * Whisper) through the main process.
 *
 * Groq has no streaming ASR over HTTP, so to keep the recorder path *live* we
 * re-transcribe the growing recording every {@link LIVE_INTERVAL_MS} and push
 * the running transcript out as an interim result; on stop we do a final pass
 * over the whole clip. It's a little wasteful (each tick re-sends the audio so
 * far) but Whisper is fast/cheap and voice input is short.
 *
 * `onResult(text, isFinal)` fires with the cumulative transcript: repeatedly
 * (interim) while listening, and once (final) when done. The caller renders it
 * into the input live and commits on `isFinal`.
 */
const LIVE_INTERVAL_MS = 2500;
const RECORDER_TIMESLICE_MS = 1000;

/**
 * Decode a recorded clip (webm/opus from MediaRecorder, or anything else the
 * browser's decoder understands) into 16 kHz mono PCM WAV bytes, ready to
 * feed to the local Whisper sidecar over stdin.
 *
 * Uses the Web Audio API (native to Chromium/Electron, no extra dependency):
 * decodeAudioData does the container/codec decode, then an OfflineAudioContext
 * resamples to 16 kHz mono in one pass. The sidecar itself never has to deal
 * with WebM/Opus — see voice-sidecar.ts on the main-process side.
 */
async function decodeToWav16kMono(blob: Blob): Promise<Uint8Array> {
  const TARGET_SAMPLE_RATE = 16000;
  const AudioCtxCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtxCtor) {
    throw new Error("Web Audio API is unavailable in this environment.");
  }
  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new AudioCtxCtor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    void decodeCtx.close().catch(() => undefined);
  }

  const frameCount = Math.max(
    1,
    Math.ceil(decoded.duration * TARGET_SAMPLE_RATE),
  );
  const OfflineCtxCtor =
    window.OfflineAudioContext ||
    (
      window as unknown as {
        webkitOfflineAudioContext?: typeof OfflineAudioContext;
      }
    ).webkitOfflineAudioContext;
  const offlineCtx = new OfflineCtxCtor(1, frameCount, TARGET_SAMPLE_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start();
  const rendered = await offlineCtx.startRendering();
  const samples = rendered.getChannelData(0);
  return encodeWavPcm16(samples, TARGET_SAMPLE_RATE);
}

/** Encode mono float32 samples in [-1, 1] as a 16-bit PCM WAV file. */
function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  const writeString = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++)
      view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += bytesPerSample) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

export interface UseVoiceInput {
  supported: boolean;
  recording: boolean;
  /** A transcription request is in flight (final pass on the recorder path). */
  transcribing: boolean;
  error: string | null;
  toggle: () => void;
}

// SpeechRecognition is non-standard; the DOM lib doesn't type it.
interface SpeechResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function useVoiceInput(
  onResult: (text: string, isFinal: boolean) => void,
  profile?: string,
): UseVoiceInput {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const liveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // True while a re-transcription request is in flight (so interim ticks don't
  // pile up) and once the user has hit stop (so a late interim can't clobber
  // the final, more-complete transcript).
  const inFlightRef = useRef(false);
  const finalizingRef = useRef(false);
  // Tri-state cache for whether the local (offline, Rust/candle Whisper)
  // sidecar is usable: null = not yet determined, true = known available,
  // false = known unavailable (not bundled on this platform) — once false we
  // stop trying it for the rest of the component's lifetime instead of
  // paying a failed-spawn round trip on every tick.
  const localSidecarRef = useRef<boolean | null>(null);
  // True while the *sidecar* owns the microphone (as opposed to
  // MediaRecorder), so toggle()/cleanup know which one to shut down.
  const sidecarRecordingRef = useRef(false);
  // Why the sidecar declined, kept for the console so a failure there is
  // never silently reported as a getUserMedia problem.
  const sidecarErrorRef = useRef<string | null>(null);
  // Keep the latest onResult without re-creating callbacks each render.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const SpeechCtor = getSpeechRecognitionCtor();
  const canRecord =
    typeof window.MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;
  const supported = !!SpeechCtor || canRecord;

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
  }, []);

  // Transcribe the audio captured so far. `isFinal` marks the post-stop pass.
  const transcribeAccumulated = useCallback(
    async (isFinal: boolean): Promise<void> => {
      if (chunksRef.current.length === 0) return;
      if (!isFinal && inFlightRef.current) return; // skip overlapping interims
      inFlightRef.current = true;
      try {
        const type = recorderRef.current?.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        if (blob.size === 0) return;

        let text: string | null = null;

        // Local, fully offline path first — a bundled Rust/candle Whisper
        // sidecar that needs neither the network nor a running Hermes API
        // server. Falls through to the existing cloud transcription below
        // when the sidecar isn't bundled for this platform, or a given
        // attempt fails for any other reason (e.g. first-run model
        // download still in progress).
        if (localSidecarRef.current !== false) {
          try {
            const wav = await decodeToWav16kMono(blob);
            const language = (navigator.language || "ru").split("-")[0];
            text = await window.hermesAPI.transcribeAudioLocal(wav, language);
            localSidecarRef.current = true;
          } catch (localErr) {
            const message =
              localErr instanceof Error ? localErr.message : String(localErr);
            if (/isn't bundled for this platform/.test(message)) {
              // Known-permanent: don't retry the sidecar again this session.
              localSidecarRef.current = false;
            }
            text = null;
          }
        }

        if (text === null) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          text = await window.hermesAPI.transcribeAudio(
            bytes,
            blob.type,
            profile,
          );
        }

        // A late interim must not overwrite the final transcript.
        if (!isFinal && finalizingRef.current) return;
        if (text) onResultRef.current(text, isFinal);
        else if (isFinal) setError("No speech detected.");
      } catch (e) {
        // Interim failures are transient — only surface the final one.
        if (isFinal) setError((e as Error).message || "Transcription failed.");
      } finally {
        inFlightRef.current = false;
      }
    },
    [profile],
  );

  /**
   * Opens the microphone. Some devices — notably laptops using Intel Smart
   * Sound Technology for their digital mic array — fail Chromium's default
   * getUserMedia call with NotReadableError ("Could not start audio
   * source"), because Chromium's built-in audio processing (echo
   * cancellation / noise suppression / auto gain control) can't negotiate
   * with that driver's own DSP pipeline, even though the OS and every
   * non-Chromium app can open the same device fine. Retrying once with that
   * processing explicitly turned off falls back to a plain, unprocessed
   * capture path that those drivers do support.
   */
  async function getMicStream(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = (e as { name?: string } | undefined)?.name;
      if (name !== "NotReadableError") throw e;
      return navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    }
  }

  const startMediaRecorder = useCallback(async () => {
    if (!canRecord) {
      setError("Voice input isn't available here.");
      return;
    }
    try {
      const stream = await getMicStream();
      streamRef.current = stream;
      chunksRef.current = [];
      finalizingRef.current = false;
      inFlightRef.current = false;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        finalizingRef.current = true;
        if (liveTimerRef.current) {
          clearInterval(liveTimerRef.current);
          liveTimerRef.current = null;
        }
        stopStream();
        recorderRef.current = null;
        setRecording(false);
        setTranscribing(true);
        await transcribeAccumulated(true);
        chunksRef.current = [];
        setTranscribing(false);
      };
      // Timeslice so chunks accumulate; the interval re-transcribes them live.
      recorder.start(RECORDER_TIMESLICE_MS);
      liveTimerRef.current = setInterval(() => {
        void transcribeAccumulated(false);
      }, LIVE_INTERVAL_MS);
      setRecording(true);
      setError(null);
    } catch (e) {
      // Say what actually went wrong. The DOMException name is the only
      // signal the browser gives, and each one means something different:
      //
      // NotReadableError — the device exists and permission was granted, but
      // the OS still refused to open it. On Windows that is almost always an
      // endpoint-protection product denying the application access to sound
      // recording devices (Kaspersky's Host Intrusion Prevention does exactly
      // this to unsigned or unknown applications). No retry, no other capture
      // API and no audio format can get around it — only a policy change can
      // — so the message has to point at that instead of leaving the user to
      // debug an opaque "could not start audio source".
      const err = e as { name?: string; message?: string } | undefined;
      const name = err?.name;
      const detail = name
        ? `${name}${err?.message ? `: ${err.message}` : ""}`
        : String(e);
      if (sidecarErrorRef.current) {
        console.warn(
          "[voice] both capture paths failed; sidecar said:",
          sidecarErrorRef.current,
        );
      }
      if (name === "NotReadableError") setError(t("chat.voiceBlocked"));
      else if (name === "NotAllowedError" || name === "SecurityError")
        setError(t("chat.voiceDenied"));
      else if (name === "NotFoundError" || name === "OverconstrainedError")
        setError(t("chat.voiceNoDevice"));
      else setError(t("chat.voiceFailed", { detail }));
      setRecording(false);
    }
  }, [canRecord, stopStream, transcribeAccumulated, t]);

  const startSpeechRecognition = useCallback(() => {
    if (!SpeechCtor) {
      void startMediaRecorder();
      return;
    }
    let gotResult = false;
    const rec = new SpeechCtor();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      gotResult = true;
      let text = "";
      let isFinal = false;
      for (let i = 0; i < event.results.length; i++) {
        const r = event.results[i];
        text += r[0].transcript;
        isFinal = r.isFinal;
      }
      onResultRef.current(text.trim(), isFinal);
    };
    rec.onerror = (event) => {
      recognitionRef.current = null;
      setRecording(false);
      // Electron's Chromium usually can't reach a speech backend → fall back to
      // recording + server-side transcription transparently.
      if (
        !gotResult &&
        (event.error === "network" ||
          event.error === "service-not-allowed" ||
          event.error === "not-allowed" ||
          event.error === "audio-capture")
      ) {
        void startMediaRecorder();
      }
    };
    rec.onend = () => {
      recognitionRef.current = null;
      setRecording(false);
    };
    recognitionRef.current = rec;
    try {
      rec.start();
      setRecording(true);
      setError(null);
    } catch {
      recognitionRef.current = null;
      void startMediaRecorder();
    }
  }, [SpeechCtor, startMediaRecorder]);

  /**
   * Preferred capture path: the microphone is opened by the bundled Rust
   * sidecar (cpal → WASAPI shared mode), not by Chromium.
   *
   * Chromium opens Windows capture devices in *raw* mode whenever it decides
   * no audio processing is needed, which Intel Smart Sound microphone arrays
   * reject outright (IAudioClient::Initialize → E_INVALIDARG), surfacing here
   * as "NotReadableError: Could not start audio source" even though the OS
   * and its own Voice Recorder can use the very same device. The sidecar asks
   * for the device the ordinary way, so that whole failure mode disappears —
   * and since it also runs Whisper locally, nothing leaves the machine.
   *
   * Returns false when the sidecar isn't usable (not bundled, no device, or
   * it failed to start) so the caller can fall back to the browser paths.
   */
  const startSidecarRecording = useCallback(async (): Promise<boolean> => {
    if (localSidecarRef.current === false) return false;
    if (!window.hermesAPI?.startVoiceRecording) return false;
    const language = (navigator.language || "ru").split("-")[0];
    try {
      await window.hermesAPI.startVoiceRecording(language);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/isn't bundled for this platform/.test(message)) {
        // Known-permanent: stop paying a failed spawn on every press.
        localSidecarRef.current = false;
      } else {
        sidecarErrorRef.current = message;
        console.warn("[voice] local sidecar could not record:", message);
      }
      return false;
    }
    localSidecarRef.current = true;
    sidecarRecordingRef.current = true;
    finalizingRef.current = false;
    inFlightRef.current = false;
    setRecording(true);
    setError(null);
    // Live interim transcripts: the sidecar re-runs Whisper over everything
    // captured so far without interrupting the recording.
    liveTimerRef.current = setInterval(() => {
      if (finalizingRef.current || inFlightRef.current) return;
      inFlightRef.current = true;
      void window.hermesAPI
        .partialVoiceTranscript()
        .then((text) => {
          if (finalizingRef.current) return;
          if (text) onResultRef.current(text, false);
        })
        .catch(() => undefined) // interim failures are transient
        .finally(() => {
          inFlightRef.current = false;
        });
    }, LIVE_INTERVAL_MS);
    return true;
  }, []);

  /** Stops the sidecar recording and commits its final transcript. */
  const finishSidecarRecording = useCallback(async (): Promise<void> => {
    sidecarRecordingRef.current = false;
    finalizingRef.current = true;
    if (liveTimerRef.current) {
      clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    }
    setRecording(false);
    setTranscribing(true);
    try {
      const text = await window.hermesAPI.stopVoiceRecording();
      if (text) onResultRef.current(text, true);
      else setError("No speech detected.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transcription failed.");
    } finally {
      setTranscribing(false);
    }
  }, []);

  const toggle = useCallback(() => {
    if (recording) {
      if (sidecarRecordingRef.current) {
        void finishSidecarRecording();
        return;
      }
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          /* ignore */
        }
        recognitionRef.current = null;
      }
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop(); // onstop runs the final transcription
      } else {
        setRecording(false);
      }
      return;
    }
    if (transcribing) return;
    setError(null);
    void (async () => {
      if (await startSidecarRecording()) return;
      if (SpeechCtor) startSpeechRecognition();
      else void startMediaRecorder();
    })();
  }, [
    recording,
    transcribing,
    SpeechCtor,
    startSpeechRecognition,
    startMediaRecorder,
    startSidecarRecording,
    finishSidecarRecording,
  ]);

  // Tear down any live capture on unmount.
  useEffect(
    () => () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        /* ignore */
      }
      if (liveTimerRef.current) clearInterval(liveTimerRef.current);
      if (sidecarRecordingRef.current) {
        sidecarRecordingRef.current = false;
        void window.hermesAPI?.cancelVoiceRecording?.().catch(() => undefined);
      }
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try {
          recorderRef.current.stop();
        } catch {
          /* ignore */
        }
      }
      stopStream();
    },
    [stopStream],
  );

  return { supported, recording, transcribing, error, toggle };
}
