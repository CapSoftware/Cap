use super::*;

fn tone(hz: f32, ms: usize) -> Vec<f32> {
    (0..ms * 16)
        .map(|i| 0.3 * (2.0 * std::f32::consts::PI * hz * i as f32 / 16_000.0).sin())
        .collect()
}

#[test]
fn frame_count_snips_to_the_edges() {
    assert_eq!(Fbank::frames(0), 0);
    assert_eq!(Fbank::frames(399), 0);
    assert_eq!(Fbank::frames(400), 1);
    assert_eq!(Fbank::frames(559), 1);
    assert_eq!(Fbank::frames(560), 2);
    assert_eq!(Fbank::frames(16_000), 98);
}

#[test]
fn a_tone_peaks_in_the_bin_holding_its_frequency() {
    let mut fbank = Fbank::default();
    let mut out = Vec::new();
    fbank.compute(&tone(1_000.0, 500), 1.0, false, &mut out);
    assert_eq!(out.len(), Fbank::frames(8_000) * NUM_BINS);
    let row = &out[10 * NUM_BINS..11 * NUM_BINS];
    let peak = (0..NUM_BINS)
        .max_by(|&a, &b| row[a].total_cmp(&row[b]))
        .unwrap();
    let low = mel(LOW_HZ);
    let delta = (mel(8_000.0) - low) / (NUM_BINS + 1) as f32;
    let expected = ((mel(1_000.0) - low) / delta - 1.0).round() as usize;
    assert!(
        peak.abs_diff(expected) <= 1,
        "peak {peak}, expected {expected}"
    );
}

#[test]
fn mean_normalisation_centres_every_bin() {
    let mut fbank = Fbank::default();
    let mut out = vec![7.0; 3];
    let mut audio = tone(300.0, 400);
    audio.extend(tone(2_500.0, 400));
    fbank.compute(&audio, 32_768.0, true, &mut out);
    assert_eq!(&out[..3], &[7.0, 7.0, 7.0]);
    let frames = (out.len() - 3) / NUM_BINS;
    for bin in 0..NUM_BINS {
        let mean: f32 = (0..frames)
            .map(|f| out[3 + f * NUM_BINS + bin])
            .sum::<f32>()
            / frames as f32;
        assert!(mean.abs() < 1e-3, "bin {bin} mean {mean}");
    }
}

#[test]
fn silence_gives_finite_floor_values() {
    let mut fbank = Fbank::default();
    let mut out = Vec::new();
    fbank.compute(&vec![0.0; 4_000], 1.0, false, &mut out);
    assert!(!out.is_empty());
    assert!(out.iter().all(|v| v.is_finite()));
    assert!(out.iter().all(|v| (*v - f32::EPSILON.ln()).abs() < 1e-3));
}

#[test]
fn every_mel_bin_has_weights() {
    for (first, weights) in mel_banks() {
        assert!(!weights.is_empty());
        assert!(first + weights.len() <= FFT_LEN / 2);
    }
}
