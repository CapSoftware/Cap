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

fn try_zeroed<T: Clone>(len: usize, value: T, label: &str) -> Result<Vec<T>, String> {
    let mut values = Vec::new();
    values
        .try_reserve_exact(len)
        .map_err(|_| format!("{label} is too large"))?;
    values.resize(len, value);
    Ok(values)
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
    let mut sums = try_zeroed(frames, 0.0_f32, "Transcription audio")?;
    let mut counts = try_zeroed(frames, 0_u32, "Transcription audio")?;

    for source in &take.sources {
        let offset = offset_samples(source.offset_secs, sample_rate)?;
        let source_frames = source.samples.len() / source.channels;
        for source_frame in 0..source_frames {
            let destination = source_frame as i128 - offset as i128;
            if destination < 0 || destination >= frames as i128 {
                continue;
            }

            let first_sample = source_frame * source.channels;
            let mono = source.samples[first_sample..first_sample + source.channels]
                .iter()
                .copied()
                .sum::<f32>()
                / source.channels as f32;
            let destination = destination as usize;
            sums[destination] += mono;
            counts[destination] += 1;
        }
    }

    output.extend(
        sums.into_iter()
            .zip(counts)
            .map(|(sum, count)| if count == 0 { 0.0 } else { sum / count as f32 }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{TranscriptionAudioSource, TranscriptionAudioTake, assemble_transcription_audio};

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
    fn invalid_timing_is_rejected_before_allocation() {
        let invalid_duration = [take(f64::NAN, Vec::new())];
        let invalid_offset = [take(1.0, vec![source(vec![1.0], 1, f64::INFINITY)])];

        assert!(assemble_transcription_audio(&invalid_duration, 48_000).is_err());
        assert!(assemble_transcription_audio(&invalid_offset, 48_000).is_err());
    }
}
