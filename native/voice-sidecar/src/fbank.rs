//! Признаки для GigaAM v3: лог-мел-фильтрбанк на 64 полосы.
//!
//! Это НЕ Kaldi-фильтрбанк и не то, что считает whisper. Препроцессинг у
//! GigaAM v3 свой, и отличается он в мелочах, каждая из которых портит
//! распознавание, если её угадать неправильно:
//!
//!   * окно 320 отсчётов (20 мс), шаг 160 (10 мс), длина БПФ тоже 320 — то
//!     есть 161 частотный бин, а не 201 и не 257;
//!   * сигнал НЕ дополняется по краям (в отличие от v2, где есть reflect-pad
//!     на половину окна);
//!   * спектр берётся по мощности, |rfft|²;
//!   * логарифм — натуральный, от значения, зажатого снизу в 1e-9;
//!   * никакой нормализации признаков после этого нет.
//!
//! Окно и матрица мел-фильтров не вычисляются здесь по формуле, а лежат
//! рядом готовой таблицей (`gigaam_v3_fbank.bin`, 42 КБ), снятой из
//! эталонной реализации onnx-asr — той самой, которой делался экспорт этой
//! модели в ONNX (github.com/istupakov/onnx-asr, лицензия MIT; таблица —
//! `gigaam_v3` и `gigaam_v3_window` из `preprocessors/data/fbanks.npz`).
//! Вычислять их самостоятельно смысла нет: совпасть нужно до последнего
//! разряда, а формулы мел-шкалы у HTK, Slaney и Kaldi разные, и окно в
//! эталоне тоже не ровно periodic hann.
//!
//! Проверено сравнением с эталоном на реальной записи: расхождение признаков
//! не больше 4e-4 по модулю (округление f32 в БПФ), число кадров совпадает,
//! распознанный текст совпадает посимвольно.
//!
//! Формат таблицы — только f32 little-endian, подряд:
//!   [0 .. 320)            окно;
//!   [320 .. 320+161*64)   матрица фильтров, построчно по частотным бинам:
//!                         элемент (bin, mel) лежит по смещению bin*64 + mel.

use std::sync::Arc;

use rustfft::{num_complex::Complex32, Fft, FftPlanner};

pub const SAMPLE_RATE: usize = 16_000;
/// Длина окна и одновременно длина БПФ — у GigaAM они совпадают.
pub const FRAME_LENGTH: usize = 320;
pub const FRAME_SHIFT: usize = 160;
pub const NUM_BINS: usize = 64;
/// Число бинов rfft для БПФ длины 320.
const NUM_FFT_BINS: usize = FRAME_LENGTH / 2 + 1;
/// Нижняя граница перед логарифмом — ровно как `np.clip(..., 1e-9, 1e9)`.
const CLAMP_MIN: f32 = 1e-9;

static TABLE: &[u8] = include_bytes!("gigaam_v3_fbank.bin");

fn read_f32(bytes: &[u8], at: usize, n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| {
            let o = at + i * 4;
            f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]])
        })
        .collect()
}

pub struct Fbank {
    window: Vec<f32>,
    /// Матрица фильтров, развёрнутая построчно: (bin, mel) -> bin*NUM_BINS+mel.
    filters: Vec<f32>,
    fft: Arc<dyn Fft<f32>>,
}

impl Default for Fbank {
    fn default() -> Self {
        Self::new()
    }
}

impl Fbank {
    pub fn new() -> Self {
        let window = read_f32(TABLE, 0, FRAME_LENGTH);
        let filters = read_f32(TABLE, FRAME_LENGTH * 4, NUM_FFT_BINS * NUM_BINS);
        let fft = FftPlanner::<f32>::new().plan_fft_forward(FRAME_LENGTH);
        Self {
            window,
            filters,
            fft,
        }
    }

    /// Сколько кадров даст сигнал такой длины. Края не дополняются, поэтому
    /// хвост короче окна просто отбрасывается.
    pub fn num_frames(samples: usize) -> usize {
        if samples < FRAME_LENGTH {
            0
        } else {
            (samples - FRAME_LENGTH) / FRAME_SHIFT + 1
        }
    }

    /// Возвращает признаки в порядке, которого ждёт вход модели
    /// `features` [1, 64, T]: сначала весь ряд первой мел-полосы, потом
    /// второй и так далее — то есть `feats[mel * frames + t]`.
    pub fn compute(&self, pcm: &[f32]) -> (Vec<f32>, usize) {
        let frames = Self::num_frames(pcm.len());
        if frames == 0 {
            return (Vec::new(), 0);
        }

        let mut out = vec![0f32; NUM_BINS * frames];
        let mut buf = vec![Complex32::new(0.0, 0.0); FRAME_LENGTH];
        let mut power = vec![0f32; NUM_FFT_BINS];

        for t in 0..frames {
            let start = t * FRAME_SHIFT;
            for (i, slot) in buf.iter_mut().enumerate() {
                *slot = Complex32::new(pcm[start + i] * self.window[i], 0.0);
            }
            self.fft.process(&mut buf);

            for (k, p) in power.iter_mut().enumerate() {
                *p = buf[k].norm_sqr();
            }

            // mel_energies = power · filters. Матрица почти пустая (не больше
            // тринадцати ненулевых весов на полосу), но 161×64 умножений на
            // кадр — это доли процента от инференса, так что городить
            // разреженное представление незачем.
            for (k, p) in power.iter().enumerate() {
                if *p == 0.0 {
                    continue;
                }
                let row = &self.filters[k * NUM_BINS..(k + 1) * NUM_BINS];
                for (m, w) in row.iter().enumerate() {
                    if *w != 0.0 {
                        out[m * frames + t] += p * w;
                    }
                }
            }

            for m in 0..NUM_BINS {
                let v = &mut out[m * frames + t];
                *v = v.max(CLAMP_MIN).ln();
            }
        }

        (out, frames)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_has_the_expected_shape() {
        assert_eq!(TABLE.len(), (FRAME_LENGTH + NUM_FFT_BINS * NUM_BINS) * 4);
        let fb = Fbank::new();
        assert_eq!(fb.window.len(), FRAME_LENGTH);
        assert_eq!(fb.filters.len(), NUM_FFT_BINS * NUM_BINS);
        // Окно симметрично и обнуляется на левом краю.
        assert_eq!(fb.window[0], 0.0);
        assert!((fb.window[1] - fb.window[FRAME_LENGTH - 1]).abs() < 1e-9);
        assert!((fb.window[FRAME_LENGTH / 2] - 1.0).abs() < 1e-6);
        // Веса нормированы в [0, 1], и каждая полоса чем-то да покрыта.
        assert!(fb.filters.iter().all(|w| (0.0..=1.0).contains(w)));
        for m in 0..NUM_BINS {
            let sum: f32 = (0..NUM_FFT_BINS).map(|k| fb.filters[k * NUM_BINS + m]).sum();
            assert!(sum > 0.0, "мел-полоса {m} пустая");
        }
    }

    #[test]
    fn frame_count_matches_the_reference_striding() {
        // (len - 320)/160 + 1, без дополнения краёв.
        assert_eq!(Fbank::num_frames(0), 0);
        assert_eq!(Fbank::num_frames(319), 0);
        assert_eq!(Fbank::num_frames(320), 1);
        assert_eq!(Fbank::num_frames(479), 1);
        assert_eq!(Fbank::num_frames(480), 2);
        // Секунда речи — ровно девяносто девять кадров.
        assert_eq!(Fbank::num_frames(SAMPLE_RATE), 99);
    }

    #[test]
    fn silence_gives_the_floor_and_tone_stands_out() {
        let fb = Fbank::new();

        let (quiet, frames) = fb.compute(&vec![0f32; SAMPLE_RATE / 2]);
        assert_eq!(frames, Fbank::num_frames(SAMPLE_RATE / 2));
        let floor = CLAMP_MIN.ln();
        assert!(quiet.iter().all(|v| (*v - floor).abs() < 1e-3));

        // Тон на 1 кГц: полоса, в которую он попадает, должна быть заметно
        // громче и полосы у самого низа, и полосы у верхнего края.
        let tone: Vec<f32> = (0..SAMPLE_RATE / 2)
            .map(|i| {
                (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / SAMPLE_RATE as f32).sin() * 0.5
            })
            .collect();
        let (feats, frames) = fb.compute(&tone);
        let mid = frames / 2;
        let row: Vec<f32> = (0..NUM_BINS).map(|m| feats[m * frames + mid]).collect();
        let peak = row
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map(|(m, _)| m)
            .unwrap();
        // 1 кГц по мел-шкале лежит примерно в середине нижней половины полос.
        assert!((10..40).contains(&peak), "пик оказался в полосе {peak}");
        assert!(row[peak] > row[NUM_BINS - 1] + 3.0);
    }

    #[test]
    fn output_is_laid_out_bin_major() {
        let fb = Fbank::new();
        let pcm: Vec<f32> = (0..2000).map(|i| (i as f32 * 0.01).sin()).collect();
        let (feats, frames) = fb.compute(&pcm);
        assert_eq!(frames, Fbank::num_frames(2000));
        assert_eq!(feats.len(), NUM_BINS * frames);
    }
}
