#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptionAudioSource {
    pub samples: Vec<f32>,
    pub channels: usize,
    pub offset_secs: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptionAudioTake {
    pub display_duration_secs: f64,
    pub sources: Vec<TranscriptionAudioSource>,
}

fn sample_count(duration_secs: f64, sample_rate: u32, label: &str) -> Result<usize, String> {
    if !duration_secs.is_finite() || duration_secs < 0.0 {
        return Err(format!("{label} must be finite and non-negative"));
    }

    let count = duration_secs * f64::from(sample_rate);
    if !count.is_finite() || count > usize::MAX as f64 {
        return Err(format!("{label} is too large"));
    }

    Ok(count.round() as usize)
}

fn offset_samples(offset_secs: f64, sample_rate: u32) -> Result<isize, String> {
    if !offset_secs.is_finite() {
        return Err("Audio source offset must be finite".to_string());
    }

    let samples = offset_secs * f64::from(sample_rate);
    if !samples.is_finite() || samples < isize::MIN as f64 || samples > isize::MAX as f64 {
        return Err("Audio source offset is too large".to_string());
    }

    Ok(samples.round() as isize)
}

pub fn assemble_transcription_audio(
    takes: &[TranscriptionAudioTake],
    sample_rate: u32,
) -> Result<Vec<f32>, String> {
    let mut output = Vec::new();
    for take in takes {
        append_transcription_audio(&mut output, take, sample_rate)?;
    }
    Ok(output)
}

pub fn append_transcription_audio(
    output: &mut Vec<f32>,
    take: &TranscriptionAudioTake,
    sample_rate: u32,
) -> Result<(), String> {
    if sample_rate == 0 {
        return Err("Audio sample rate must be positive".to_string());
    }

    let frames = sample_count(take.display_duration_secs, sample_rate, "Display duration")?;
    for source in &take.sources {
        if source.channels == 0 {
            return Err("Audio source must have at least one channel".to_string());
        }
        if source.samples.len() % source.channels != 0 {
            return Err("Audio source samples are not channel aligned".to_string());
        }
        offset_samples(source.offset_secs, sample_rate)?;
    }

    output
        .try_reserve_exact(frames)
        .map_err(|_| "Transcription audio is too large".to_string())?;
    let mut boundaries = Vec::new();
    boundaries
        .try_reserve_exact(take.sources.len() * 2)
        .map_err(|_| "Transcription audio is too large".to_string())?;
    let start = output.len();
    output.resize(start + frames, 0.0);
    let sums = &mut output[start..];

    for source in &take.sources {
        let offset = offset_samples(source.offset_secs, sample_rate)?;
        let source_frames = source.samples.len() / source.channels;
        let first = (-(offset as i128)).clamp(0, frames as i128) as usize;
        let end = (source_frames as i128 - offset as i128).clamp(0, frames as i128) as usize;
        if first == end {
            continue;
        }
        boundaries.push((first, true));
        boundaries.push((end, false));
        let source_start = (first as i128 + offset as i128) as usize;
        for (sum, frame) in sums[first..end].iter_mut().zip(
            source
                .samples
                .chunks_exact(source.channels)
                .skip(source_start),
        ) {
            *sum += frame.iter().copied().sum::<f32>() / source.channels as f32;
        }
    }

    // Each source covers one interval; its contribution count only changes at the ends.
    boundaries.sort_unstable_by_key(|(position, _)| *position);
    let mut count = 0_u32;
    let mut start = 0;
    for (end, starting) in boundaries {
        if count > 1 {
            for sample in &mut sums[start..end] {
                *sample /= count as f32;
            }
        }
        if starting {
            count += 1;
        } else {
            count -= 1;
        }
        start = end;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        TranscriptionAudioSource, TranscriptionAudioTake, append_transcription_audio,
        assemble_transcription_audio, offset_samples, sample_count,
    };

    fn take(duration: f64, sources: Vec<TranscriptionAudioSource>) -> TranscriptionAudioTake {
        TranscriptionAudioTake {
            display_duration_secs: duration,
            sources,
        }
    }

    fn source(samples: Vec<f32>, channels: usize, offset_secs: f64) -> TranscriptionAudioSource {
        TranscriptionAudioSource {
            samples,
            channels,
            offset_secs,
        }
    }

    #[test]
    fn silent_first_take_preserves_display_time() {
        let takes = [
            take(2.0, Vec::new()),
            take(1.0, vec![source(vec![1.0; 48_000], 1, 0.0)]),
        ];

        let output = assemble_transcription_audio(&takes, 48_000).unwrap();

        assert_eq!(output.len(), 144_000);
        assert!(output[..96_000].iter().all(|sample| *sample == 0.0));
        assert!(output[96_000..].iter().all(|sample| *sample == 1.0));
    }

    #[test]
    fn short_audio_is_padded_to_display_duration() {
        let takes = [take(2.0, vec![source(vec![1.0; 24_000], 1, 0.0)])];

        let output = assemble_transcription_audio(&takes, 48_000).unwrap();

        assert_eq!(output.len(), 96_000);
        assert!(output[..24_000].iter().all(|sample| *sample == 1.0));
        assert!(output[24_000..].iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn staggered_starts_trim_and_prepend() {
        let takes = [take(
            2.0,
            vec![
                source(vec![1.0; 96_000], 1, 0.5),
                source(vec![2.0; 48_000], 1, -0.5),
            ],
        )];

        let output = assemble_transcription_audio(&takes, 48_000).unwrap();

        assert!(output[..24_000].iter().all(|sample| *sample == 1.0));
        assert!(output[24_000..72_000].iter().all(|sample| *sample == 1.5));
        assert!(output[72_000..].iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn multitrack_mix_downmixes_and_averages_overlaps() {
        let takes = [take(
            1.0,
            vec![
                source(vec![1.0, 3.0, 1.0, 3.0], 2, 0.0),
                source(vec![0.5, 0.5], 1, 0.0),
            ],
        )];

        let output = assemble_transcription_audio(&takes, 2).unwrap();

        assert_eq!(output, vec![1.25, 1.25]);
    }

    #[test]
    fn appending_audio_preserves_previous_takes() {
        let mut output = vec![0.25, -0.5];
        let mixed = take(
            2.0,
            vec![
                source(vec![1.0, 3.0, 3.0, 5.0], 2, -0.5),
                source(vec![2.0, 4.0, 6.0], 1, 0.0),
            ],
        );

        append_transcription_audio(&mut output, &mixed, 2).unwrap();
        append_transcription_audio(&mut output, &take(1.0, Vec::new()), 2).unwrap();

        assert_eq!(output, vec![0.25, -0.5, 2.0, 3.0, 5.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn failed_append_preserves_existing_audio() {
        for (take, sample_rate) in [
            (take(1.0, Vec::new()), 0),
            (take(f64::NAN, Vec::new()), 2),
            (take(usize::MAX as f64, Vec::new()), 1),
            (take(1.0, vec![source(vec![1.0], 0, 0.0)]), 2),
            (take(1.0, vec![source(vec![1.0], 2, 0.0)]), 2),
            (take(1.0, vec![source(vec![1.0], 1, f64::INFINITY)]), 2),
        ] {
            let mut output = vec![0.25, -0.5];

            assert!(append_transcription_audio(&mut output, &take, sample_rate).is_err());
            assert_eq!(output, vec![0.25, -0.5]);
        }
    }

    #[test]
    fn invalid_timing_is_rejected_before_allocation() {
        let invalid_duration = [take(f64::NAN, Vec::new())];
        let invalid_offset = [take(1.0, vec![source(vec![1.0], 1, f64::INFINITY)])];

        assert!(assemble_transcription_audio(&invalid_duration, 48_000).is_err());
        assert!(assemble_transcription_audio(&invalid_offset, 48_000).is_err());
    }

    fn reference(take: &TranscriptionAudioTake, rate: u32) -> Vec<f32> {
        let frames = sample_count(take.display_duration_secs, rate, "Display duration").unwrap();
        let mut sums = vec![0.0_f32; frames];
        let mut counts = vec![0_u32; frames];
        for source in &take.sources {
            let offset = offset_samples(source.offset_secs, rate).unwrap();
            for source_frame in 0..source.samples.len() / source.channels {
                let destination = source_frame as i128 - offset as i128;
                if destination < 0 || destination >= frames as i128 {
                    continue;
                }
                let first = source_frame * source.channels;
                sums[destination as usize] += source.samples[first..first + source.channels]
                    .iter()
                    .copied()
                    .sum::<f32>()
                    / source.channels as f32;
                counts[destination as usize] += 1;
            }
        }
        sums.into_iter()
            .zip(counts)
            .map(|(sum, count)| if count == 0 { 0.0 } else { sum / count as f32 })
            .collect()
    }

    fn bits(samples: &[f32]) -> Vec<u32> {
        samples.iter().map(|sample| sample.to_bits()).collect()
    }

    #[test]
    fn interval_counts_match_per_sample_counts_and_preserve_previous_takes() {
        let values = [
            0.0,
            -0.0,
            0.5,
            -0.25,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NAN,
        ];
        for channels in [1, 2, 3, 6] {
            for frames in [0, 1, 9, 32] {
                for offset in [-2.0, -0.5, 0.0, 0.25, 1.0, 4.0] {
                    for source_count in 0..=3 {
                        let take = take(
                            frames as f64 / 8.0,
                            (0..source_count)
                                .map(|index| {
                                    source(
                                        (0..(frames + index) * channels)
                                            .map(|i| values[(i + index) % values.len()])
                                            .collect(),
                                        channels,
                                        offset + index as f64 / 8.0,
                                    )
                                })
                                .collect(),
                        );
                        let mut expected = vec![13.0, -0.0, f32::from_bits(0x7fc0_1234)];
                        let mut actual = expected.clone();
                        for _ in 0..3 {
                            expected.extend(reference(&take, 8));
                            append_transcription_audio(&mut actual, &take, 8).unwrap();
                            assert_eq!(actual.len(), expected.len());
                            assert_eq!(bits(&actual[..3]), bits(&expected[..3]));
                            for (actual, expected) in actual[3..].iter().zip(&expected[3..]) {
                                if expected.is_nan() {
                                    assert!(actual.is_nan());
                                } else {
                                    assert_eq!(actual.to_bits(), expected.to_bits());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn single_source_intervals_preserve_special_samples_and_existing_output() {
        let values = [
            0.0,
            -0.0,
            f32::from_bits(1),
            -f32::from_bits(1),
            f32::MIN_POSITIVE,
            f32::MAX,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::from_bits(0x7fc0_1234),
            f32::from_bits(0x7f80_1234),
        ];
        for channels in [1, 2, 6] {
            let samples: Vec<_> = values.into_iter().cycle().take(20 * channels).collect();
            for offset in [-3.0, -1.25, 0.0, 0.5, 2.0] {
                let take = take(
                    10.0,
                    vec![
                        source(samples.clone(), channels, offset),
                        source(samples.clone(), channels, -6.0),
                    ],
                );
                let mut actual = vec![-0.0, f32::from_bits(0x7fc0_4321)];
                let prefix = bits(&actual);
                append_transcription_audio(&mut actual, &take, 4).unwrap();
                assert_eq!(bits(&actual[..2]), prefix);
                let expected = reference(&take, 4);
                assert_eq!(actual.len() - 2, expected.len());
                for (actual, expected) in actual[2..].iter().zip(expected) {
                    if expected.is_nan() {
                        assert!(actual.is_nan());
                    } else {
                        assert_eq!(actual.to_bits(), expected.to_bits());
                    }
                }
            }
        }
    }

    #[test]
    fn adjacent_overlapping_and_disjoint_source_boundaries_keep_exact_averages() {
        let take = take(
            10.0,
            vec![
                source(vec![1.0; 4], 1, 0.0),
                source(vec![3.0; 4], 1, -2.0),
                source(vec![5.0; 2], 1, -4.0),
                source(vec![7.0; 1], 1, -8.0),
                source(Vec::new(), 1, -4.0),
                source(vec![9.0; 2], 1, 3.0),
            ],
        );
        let expected = vec![1.0, 1.0, 2.0, 2.0, 4.0, 4.0, 0.0, 0.0, 7.0, 0.0];
        assert_eq!(assemble_transcription_audio(&[take], 1).unwrap(), expected);
    }

    #[test]
    fn invalid_append_leaves_existing_samples_unchanged() {
        for (duration, channels, offset, rate, samples) in [
            (1.0, 1, 0.0, 0, vec![1.0]),
            (-1.0, 1, 0.0, 8, vec![1.0]),
            (f64::NAN, 1, 0.0, 8, vec![1.0]),
            (f64::MAX, 1, 0.0, 8, vec![1.0]),
            (1.0, 0, 0.0, 8, vec![1.0]),
            (1.0, 2, 0.0, 8, vec![1.0]),
            (1.0, 1, f64::NAN, 8, vec![1.0]),
            (1.0, 1, f64::INFINITY, 8, vec![1.0]),
            (1.0, 1, f64::MAX, 8, vec![1.0]),
        ] {
            let mut output = vec![0.25, -0.0];
            let expected = bits(&output);
            let take = take(
                duration,
                vec![
                    source(vec![1.0; 8], 1, 0.0),
                    source(samples, channels, offset),
                ],
            );
            assert!(append_transcription_audio(&mut output, &take, rate).is_err());
            assert_eq!(bits(&output), expected);
        }
    }
}
