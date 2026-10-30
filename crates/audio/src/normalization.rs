pub fn normalize_for_transcription(samples: &mut [f32]) -> f32 {
    if samples.is_empty() {
        return 1.0;
    }

    let peak = samples
        .iter()
        .fold(0.0_f32, |max, sample| max.max(sample.abs()));
    if peak <= f32::EPSILON {
        return 1.0;
    }

    let rms =
        (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt();
    if rms <= f32::EPSILON {
        return 1.0;
    }

    let target_rms = 0.08_f32;
    let desired_gain = (target_rms / rms).clamp(1.0, 8.0);
    let peak_limited_gain = 0.98 / peak;
    let gain = desired_gain.min(peak_limited_gain);

    if (gain - 1.0).abs() > 0.01 {
        for sample in samples {
            *sample = (*sample * gain).clamp(-0.98, 0.98);
        }
    }

    gain
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_and_nominal_audio_remain_bit_identical() {
        for mut samples in [vec![], vec![0.0_f32, -0.0], vec![0.1, -0.1]] {
            let before: Vec<_> = samples.iter().map(|sample| sample.to_bits()).collect();
            assert_eq!(normalize_for_transcription(&mut samples), 1.0);
            assert_eq!(
                samples
                    .iter()
                    .map(|sample| sample.to_bits())
                    .collect::<Vec<_>>(),
                before
            );
        }
    }

    #[test]
    fn quiet_speech_gain_stops_at_eight() {
        let mut samples = [0.01, -0.01];
        assert_eq!(normalize_for_transcription(&mut samples), 8.0);
        assert_eq!(samples, [0.08, -0.08]);
    }

    #[test]
    fn peaks_are_limited_even_when_rms_gain_would_be_one() {
        let mut samples = [2.0, -2.0];
        assert_eq!(normalize_for_transcription(&mut samples), 0.49);
        assert_eq!(samples, [0.98, -0.98]);
    }

    #[test]
    fn gain_within_one_percent_does_not_mutate_samples() {
        let mut samples = [0.985, -0.985];
        let before = samples.map(f32::to_bits);
        let gain = normalize_for_transcription(&mut samples);
        assert_eq!(gain.to_bits(), (0.98_f32 / 0.985).to_bits());
        assert_eq!(samples.map(f32::to_bits), before);
    }

    #[test]
    fn silent_nan_and_subnormal_inputs_keep_their_bits() {
        let mut samples = [f32::from_bits(0x7fc0_1234), f32::from_bits(1), -0.0];
        let before = samples.map(f32::to_bits);
        assert_eq!(normalize_for_transcription(&mut samples), 1.0);
        assert_eq!(samples.map(f32::to_bits), before);
    }
}
