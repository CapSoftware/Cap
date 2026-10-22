pub fn peaks(blocks: &[&[f32]], channels: u16) -> Vec<f32> {
    cap_audio::waveform_peaks(blocks.iter().copied(), channels)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples(len: usize) -> Vec<f32> {
        let mut state = 0x1234_5678_u32;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as f32 / u32::MAX as f32 * 2.0 - 1.0
            })
            .collect()
    }

    fn sequential_peaks(samples: &[f32], channels: u16) -> Vec<f32> {
        samples
            .chunks(4_800 * usize::from(channels))
            .map(|window| {
                let average =
                    window.iter().fold(0.0_f32, |sum, s| sum + s.abs()) / window.len() as f32;
                if average > 0.0 {
                    20.0 * average.log10()
                } else {
                    -60.0
                }
            })
            .collect()
    }

    fn assert_peak_bits(actual: &[f32], expected: &[f32], channels: u16, block_len: usize) {
        assert_eq!(actual.len(), expected.len(), "{channels} {block_len}");
        for (actual, expected) in actual.iter().zip(expected) {
            assert_eq!(
                actual.to_bits(),
                expected.to_bits(),
                "{channels} {block_len}"
            );
        }
    }

    #[test]
    fn peaks_match_a_sequential_sum_across_uneven_blocks() {
        let uneven = samples(48_000 * 3 + 1_234);
        for channels in [1, 2] {
            let expected = sequential_peaks(&uneven, channels);
            for block_len in [1, 7, 4_799, 9_600, 65_536, 32_768 * usize::from(channels)] {
                let blocks: Vec<&[f32]> = uneven.chunks(block_len).collect();
                assert_peak_bits(&peaks(&blocks, channels), &expected, channels, block_len);
            }
            assert_peak_bits(
                &peaks(&[&uneven], channels),
                &expected,
                channels,
                uneven.len(),
            );
        }

        let contiguous = samples(48_000 * 120 + 17);
        for channels in [1, 2] {
            let expected = sequential_peaks(&contiguous, channels);
            assert_peak_bits(
                &peaks(&[&contiguous], channels),
                &expected,
                channels,
                contiguous.len(),
            );
            let block_len = 32_768 * usize::from(channels);
            let blocks: Vec<&[f32]> = contiguous.chunks(block_len).collect();
            assert_peak_bits(&peaks(&blocks, channels), &expected, channels, block_len);
        }
    }

    fn serial_peaks(blocks: &[&[f32]], channels: u16) -> Vec<f32> {
        let block_samples = 48_000usize / 10 * usize::from(channels.max(1));
        let mut peaks = Vec::new();
        let mut sum = 0.0_f32;
        let mut count = 0usize;
        for slice in blocks {
            let mut slice = *slice;
            while !slice.is_empty() {
                let (window, rest) = slice.split_at((block_samples - count).min(slice.len()));
                sum = window.iter().fold(sum, |sum, sample| sum + sample.abs());
                count += window.len();
                slice = rest;
                if count == block_samples {
                    peaks.push(sum / count as f32);
                    sum = 0.0;
                    count = 0;
                }
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

    #[test]
    #[ignore]
    fn benchmark_waveform_peaks() {
        use std::{hint::black_box, time::Instant};

        for (track, channels) in [("mic", 1_u16), ("system audio", 2)] {
            let samples = samples(48_000 * 3_600 * usize::from(channels));
            let blocks: Vec<&[f32]> = samples.chunks(32_768 * usize::from(channels)).collect();
            assert_peak_bits(
                &peaks(&blocks, channels),
                &serial_peaks(&blocks, channels),
                channels,
                32_768 * usize::from(channels),
            );
            let mut serial_runs = Vec::new();
            let mut lane_runs = Vec::new();
            for _ in 0..5 {
                let start = Instant::now();
                black_box(serial_peaks(&blocks, channels));
                serial_runs.push(start.elapsed().as_secs_f64() * 1000.0);
                let start = Instant::now();
                black_box(peaks(&blocks, channels));
                lane_runs.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            serial_runs.sort_by(f64::total_cmp);
            lane_runs.sort_by(f64::total_cmp);
            println!(
                "{{\"track\":\"{track}\",\"channels\":{channels},\"duration_seconds\":3600,\"block_frames\":32768,\"serial_median_ms\":{:.1},\"serial_min_ms\":{:.1},\"lanes_median_ms\":{:.1},\"lanes_min_ms\":{:.1}}}",
                serial_runs[serial_runs.len() / 2],
                serial_runs[0],
                lane_runs[lane_runs.len() / 2],
                lane_runs[0]
            );
        }
    }
}
