pub const WINDOW_FRAMES: usize = 480;
pub const FLOOR_DB: f32 = -100.0;

pub fn loudness_db<'a>(slices: impl IntoIterator<Item = &'a [f32]>, channels: u16) -> Vec<f32> {
    let window = WINDOW_FRAMES * usize::from(channels.max(1));
    let mut levels = Vec::new();
    let mut sum = 0.0_f32;
    let mut count = 0;
    for mut slice in slices {
        while !slice.is_empty() {
            let (chunk, rest) = slice.split_at((window - count).min(slice.len()));
            sum = chunk.iter().fold(sum, |sum, sample| sum + sample * sample);
            count += chunk.len();
            slice = rest;
            if count == window {
                levels.push(mean_square_db(sum / count as f32));
                sum = 0.0;
                count = 0;
            }
        }
    }
    if count > 0 {
        levels.push(mean_square_db(sum / count as f32));
    }
    levels
}

fn mean_square_db(mean_square: f32) -> f32 {
    if mean_square.is_finite() && mean_square > 1e-10 {
        (10.0 * mean_square.log10()).max(FLOOR_DB)
    } else {
        FLOOR_DB
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(frames: usize, channels: u16, amplitude: f32) -> Vec<f32> {
        (0..frames)
            .flat_map(|frame| {
                let value =
                    amplitude * (frame as f32 * 1_000.0 * std::f32::consts::TAU / 48_000.0).sin();
                std::iter::repeat_n(value, usize::from(channels))
            })
            .collect()
    }

    #[test]
    fn digital_silence_sits_on_the_floor() {
        let samples = vec![0.0; WINDOW_FRAMES * 3];
        assert_eq!(loudness_db([samples.as_slice()], 1), vec![FLOOR_DB; 3]);
    }

    #[test]
    fn a_full_scale_sine_measures_minus_three_db() {
        let samples = sine(WINDOW_FRAMES * 10, 2, 1.0);
        let levels = loudness_db([samples.as_slice()], 2);
        assert_eq!(levels.len(), 10);
        for level in levels {
            assert!((level + 3.01).abs() < 0.05, "{level}");
        }
    }

    #[test]
    fn uneven_blocks_match_one_contiguous_slice() {
        let samples = sine(WINDOW_FRAMES * 7 + 123, 2, 0.25);
        let expected = loudness_db([samples.as_slice()], 2);
        for block in [1, 7, 959, 960, 4_096] {
            let actual = loudness_db(samples.chunks(block), 2);
            assert_eq!(actual.len(), expected.len());
            for (actual, expected) in actual.iter().zip(&expected) {
                assert!(
                    (actual - expected).abs() < 1e-4,
                    "{block}: {actual} {expected}"
                );
            }
        }
    }

    #[test]
    fn a_trailing_partial_window_is_measured() {
        let samples = sine(WINDOW_FRAMES + 10, 1, 0.5);
        assert_eq!(loudness_db([samples.as_slice()], 1).len(), 2);
        assert!(loudness_db(std::iter::empty::<&[f32]>(), 1).is_empty());
    }
}
