// Sample-rate conversion for captured audio.
//
// The device hands us whatever rate its engine runs at (48 kHz here); Whisper
// wants 16 kHz mono. Opening the microphone itself lives in wasapi.rs.

/// What Whisper wants: 16 kHz mono.
pub const TARGET_RATE: u32 = 16_000;

/// Band-limited resampling with a Blackman-windowed sinc kernel.
///
/// Microphones hand us 44.1/48 kHz; Whisper wants 16 kHz. Plain decimation
/// would fold everything above 8 kHz back into the speech band as aliasing
/// noise and measurably hurt recognition, so the kernel's cutoff is placed at
/// the lower of the two Nyquist limits and the taps are normalised to keep
/// unity DC gain.
pub fn resample(input: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if input.is_empty() || src_rate == 0 {
        return Vec::new();
    }
    if src_rate == dst_rate {
        return input.to_vec();
    }
    let ratio = dst_rate as f64 / src_rate as f64;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    // Cutoff in cycles/sample of the *source* rate, just under Nyquist.
    let cutoff = 0.5f64.min(ratio * 0.5) * 0.95;
    // Widen the kernel when downsampling so it still spans ~16 output taps.
    let taps = (16.0 / (2.0 * cutoff)).ceil();
    let mut out = Vec::with_capacity(out_len);
    for n in 0..out_len {
        let center = n as f64 / ratio;
        let start = (center - taps).ceil() as isize;
        let end = (center + taps).floor() as isize;
        let mut acc = 0.0f64;
        let mut norm = 0.0f64;
        for k in start..=end {
            if k < 0 || k as usize >= input.len() {
                continue;
            }
            let t = center - k as f64;
            let x = 2.0 * cutoff * t;
            let sinc = if x.abs() < 1e-9 {
                1.0
            } else {
                (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
            };
            let u = (t / taps).clamp(-1.0, 1.0);
            let a = std::f64::consts::PI * (u + 1.0) / 2.0;
            let window = 0.42 - 0.5 * (2.0 * a).cos() + 0.08 * (4.0 * a).cos();
            let h = sinc * window;
            acc += h * input[k as usize] as f64;
            norm += h;
        }
        out.push(if norm.abs() > 1e-12 {
            (acc / norm) as f32
        } else {
            0.0
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::resample;

    /// A 440 Hz tone downsampled 48k -> 16k must keep its amplitude and stay
    /// smooth (no aliasing blow-up), and the output length must track the rate
    /// ratio.
    #[test]
    fn resamples_a_tone_without_blowing_up() {
        let src: Vec<f32> = (0..48_000)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48_000.0).sin())
            .collect();
        let out = resample(&src, 48_000, 16_000);
        assert!((out.len() as i64 - 16_000).abs() <= 2, "len = {}", out.len());
        let peak = out[100..out.len() - 100]
            .iter()
            .fold(0f32, |m, s| m.max(s.abs()));
        assert!((0.9..=1.1).contains(&peak), "peak = {peak}");
    }

    #[test]
    fn passthrough_when_rates_match() {
        let src = vec![0.1, -0.2, 0.3];
        assert_eq!(resample(&src, 16_000, 16_000), src);
    }
}
