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

    #[test]
    fn peaks_match_a_sequential_sum_across_uneven_blocks() {
        let samples = samples(48_000 * 3 + 1_234);
        for channels in [1, 2] {
            for block_len in [1, 7, 4_799, 9_600, 65_536] {
                let blocks: Vec<&[f32]> = samples.chunks(block_len).collect();
                let actual = peaks(&blocks, channels);
                let expected = sequential_peaks(&samples, channels);
                assert_eq!(actual.len(), expected.len());
                for (actual, expected) in actual.iter().zip(&expected) {
                    assert_eq!(
                        actual.to_bits(),
                        expected.to_bits(),
                        "{channels} {block_len}"
                    );
                }
            }
        }
    }

    #[test]
    #[ignore]
    fn benchmark_waveform_peaks() {
        use std::{hint::black_box, time::Instant};

        for (track, channels) in [("mic", 1_u16), ("system audio", 2)] {
            let samples = samples(48_000 * 3_600 * usize::from(channels));
            let blocks: Vec<&[f32]> = samples.chunks(32_768 * usize::from(channels)).collect();
            let mut runs = Vec::new();
            for _ in 0..5 {
                let start = Instant::now();
                black_box(peaks(&blocks, channels));
                runs.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            runs.sort_by(f64::total_cmp);
            println!(
                "{{\"track\":\"{track}\",\"channels\":{channels},\"duration_seconds\":3600,\"median_ms\":{:.1},\"min_ms\":{:.1}}}",
                runs[runs.len() / 2],
                runs[0]
            );
        }
    }
}
