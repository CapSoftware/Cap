pub const WAVEFORM_BLOCKS_PER_SECOND: usize = 10;
const LANES: usize = 8;

pub fn waveform_peaks_from_slices(slices: &[&[f32]], channels: u16, sample_rate: u32) -> Vec<f32> {
    let block_samples =
        sample_rate as usize / WAVEFORM_BLOCKS_PER_SECOND * usize::from(channels.max(1));
    if block_samples == 0 {
        return Vec::new();
    }
    let total: usize = slices.iter().map(|slice| slice.len()).sum();
    let mut peaks = Vec::with_capacity(total.div_ceil(block_samples));
    let mut carry_sum = 0.0_f32;
    let mut carry_count = 0_usize;

    for slice in slices {
        let mut rest = *slice;
        if carry_count > 0 {
            let take = (block_samples - carry_count).min(rest.len());
            carry_sum += abs_sum(&rest[..take]);
            carry_count += take;
            rest = &rest[take..];
            if carry_count == block_samples {
                peaks.push(carry_sum / block_samples as f32);
                carry_sum = 0.0;
                carry_count = 0;
            }
        }
        let mut blocks = rest.chunks_exact(block_samples);
        for block in &mut blocks {
            peaks.push(abs_sum(block) / block_samples as f32);
        }
        let tail = blocks.remainder();
        if !tail.is_empty() {
            carry_sum += abs_sum(tail);
            carry_count += tail.len();
        }
    }
    if carry_count > 0 {
        peaks.push(carry_sum / carry_count as f32);
    }
    for peak in &mut peaks {
        *peak = if *peak > 0.0 {
            20.0 * peak.log10()
        } else {
            -60.0
        };
    }
    peaks
}

fn abs_sum(samples: &[f32]) -> f32 {
    let mut lanes = [0.0_f32; LANES];
    let mut chunks = samples.chunks_exact(LANES);
    for chunk in &mut chunks {
        for (lane, sample) in lanes.iter_mut().zip(chunk) {
            *lane += sample.abs();
        }
    }
    let tail: f32 = chunks.remainder().iter().map(|sample| sample.abs()).sum();
    lanes.iter().sum::<f32>() + tail
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    fn oracle(samples: impl Iterator<Item = f32>, channels: u16) -> Vec<f32> {
        let block_samples = RATE as usize / 10 * usize::from(channels.max(1));
        let mut peaks = Vec::new();
        let mut sum = 0.0_f32;
        let mut count = 0;
        for sample in samples {
            sum += sample.abs();
            count += 1;
            if count == block_samples {
                peaks.push(sum / count as f32);
                sum = 0.0;
                count = 0;
            }
        }
        if count > 0 {
            peaks.push(sum / count as f32);
        }
        for peak in &mut peaks {
            *peak = if *peak > 0.0 {
                20.0 * peak.log10()
            } else {
                -60.0
            };
        }
        peaks
    }

    fn signal(len: usize, seed: u32) -> Vec<f32> {
        let mut state = seed.wrapping_mul(2_654_435_761).max(1);
        (0..len)
            .map(|i| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                let noise = (state as f32 / u32::MAX as f32) * 2.0 - 1.0;
                let envelope = ((i / 20_000) % 7) as f32 / 7.0;
                noise * envelope
            })
            .collect()
    }

    fn assert_matches(slices: &[&[f32]], channels: u16) {
        let expected = oracle(slices.iter().flat_map(|s| s.iter().copied()), channels);
        let actual = waveform_peaks_from_slices(slices, channels, RATE);
        assert_eq!(actual.len(), expected.len());
        for (index, (a, e)) in actual.iter().zip(&expected).enumerate() {
            assert!((a - e).abs() <= 1e-4, "block {index}: {a} vs {e}");
        }
    }

    #[test]
    fn empty_input_has_no_peaks() {
        assert!(waveform_peaks_from_slices(&[], 2, RATE).is_empty());
        assert!(waveform_peaks_from_slices(&[&[], &[]], 2, RATE).is_empty());
    }

    #[test]
    fn silence_floors_at_minus_sixty() {
        let silent = vec![0.0_f32; 9_600 * 3 + 5];
        assert_eq!(
            waveform_peaks_from_slices(&[&silent], 2, RATE),
            vec![-60.0; 4]
        );
    }

    #[test]
    fn blocks_spanning_slices_match_the_sequential_oracle() {
        let samples = signal(9_600 * 40 + 1_234, 7);
        for split in [1, 7, 4_799, 9_599, 9_600, 9_601, 65_536] {
            let slices: Vec<&[f32]> = samples.chunks(split).collect();
            assert_matches(&slices, 2);
        }
        let (a, rest) = samples.split_at(3);
        let (b, c) = rest.split_at(19_197);
        assert_matches(&[a, &[], b, c], 2);
    }

    #[test]
    fn odd_lengths_and_channel_counts_match() {
        for (len, channels) in [
            (1, 1),
            (4_799, 1),
            (4_801, 1),
            (9_599, 2),
            (100_003, 6),
            (17, 0),
        ] {
            let samples = signal(len, len as u32);
            assert_matches(&[&samples], channels);
        }
    }

    #[test]
    fn long_contiguous_track_matches() {
        let samples = signal(RATE as usize * 2 * 600 + 77, 3);
        let slices: Vec<&[f32]> = samples.chunks(65_536).collect();
        assert_matches(&slices, 2);
        assert_matches(&[&samples], 2);
    }
}
