use super::*;
use crate::test_rng::Rng;

const PER_MS: usize = 16;

fn amp(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

fn bed(len_ms: usize, db: f32, seed: u64) -> Vec<f32> {
    let mut rng = Rng::new(seed);
    let scale = amp(db) * 3f32.sqrt();
    (0..len_ms * PER_MS).map(|_| rng.signed() * scale).collect()
}

fn add_tone(signal: &mut [f32], from_ms: usize, to_ms: usize, freq: f32, db: f32) {
    let a = amp(db) * 2f32.sqrt();
    let end = (to_ms * PER_MS).min(signal.len());
    for (i, s) in signal
        .iter_mut()
        .enumerate()
        .take(end)
        .skip(from_ms * PER_MS)
    {
        let t = i as f32 / SAMPLE_RATE as f32;
        *s += a
            * (0.7 * (2.0 * std::f32::consts::PI * freq * t).sin()
                + 0.3 * (2.0 * std::f32::consts::PI * freq * 2.1 * t).sin());
    }
}

fn add_speech(signal: &mut [f32], from_ms: usize, to_ms: usize, db: f32, tail_db: Option<f32>) {
    let mut t = from_ms;
    while t < to_ms {
        add_tone(signal, t, (t + 300).min(to_ms), 440.0, db);
        if let Some(tail) = tail_db {
            add_tone(signal, t + 300, (t + 400).min(to_ms), 440.0, tail);
        }
        t += 400;
    }
}

fn run(signal: &[f32], chunks: &mut dyn FnMut() -> usize) -> (Vec<SpeechSegment>, Segmenter) {
    let mut seg = Segmenter::new(SegmenterConfig::default());
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < signal.len() {
        let n = chunks().clamp(1, signal.len() - at);
        out.extend(seg.push(at as u64, &signal[at..at + n]));
        at += n;
    }
    out.extend(seg.flush());
    (out, seg)
}

fn run_fixed(signal: &[f32], chunk: usize) -> Vec<SpeechSegment> {
    run(signal, &mut || chunk).0
}

fn ms_of(sample: u64) -> f64 {
    sample as f64 / PER_MS as f64
}

fn assert_exact(signal: &[f32], segments: &[SpeechSegment]) {
    let mut last_end = 0u64;
    for s in segments {
        assert!(s.start_sample >= last_end, "overlap at {}", s.start_sample);
        let start = s.start_sample as usize;
        assert_eq!(
            &signal[start..start + s.samples.len()],
            s.samples.as_slice()
        );
        last_end = s.end_sample();
    }
}

#[test]
fn quiet_speaker_over_noise_bed() {
    let mut signal = bed(6_000, -50.0, 1);
    add_speech(&mut signal, 2_000, 4_000, -38.0, None);
    let segments = run_fixed(&signal, 480);
    assert_eq!(
        segments.len(),
        1,
        "{:?}",
        segments
            .iter()
            .map(|s| (s.start_sample, s.samples.len()))
            .collect::<Vec<_>>()
    );
    let s = &segments[0];
    let start = ms_of(s.start_sample);
    let end = ms_of(s.end_sample());
    assert!((1_740.0..=1_800.0).contains(&start), "start {start}");
    assert!((3_900.0..=4_300.0).contains(&end), "end {end}");
    assert!(s.speech_ms >= 1_200, "speech {}", s.speech_ms);
    assert_exact(&signal, &segments);
}

#[test]
fn loud_speaker_at_several_levels() {
    for (noise, speech) in [
        (-70.0, -20.0),
        (-55.0, -30.0),
        (-40.0, -25.0),
        (-35.0, -18.0),
    ] {
        let mut signal = bed(5_000, noise, 2);
        add_speech(&mut signal, 1_000, 3_000, speech, None);
        let segments = run_fixed(&signal, 1_000);
        assert_eq!(segments.len(), 1, "noise {noise} speech {speech}");
        assert_exact(&signal, &segments);
    }
}

#[test]
fn speech_barely_above_floor_is_ignored() {
    let mut signal = bed(5_000, -40.0, 3);
    add_speech(&mut signal, 1_000, 3_000, -36.0, None);
    assert!(run_fixed(&signal, 320).is_empty());
}

#[test]
fn digital_silence_and_dither_never_trigger() {
    let silence = vec![0.0f32; 10 * SAMPLE_RATE as usize];
    assert!(run_fixed(&silence, 777).is_empty());
    let mut dither = bed(10_000, -95.0, 4);
    add_speech(&mut dither, 3_000, 5_000, -75.0, None);
    assert!(run_fixed(&dither, 777).is_empty());
}

#[test]
fn single_click_is_discarded() {
    let mut signal = bed(4_000, -55.0, 5);
    signal[2_000 * PER_MS] = 1.0;
    signal[2_000 * PER_MS + 1] = -1.0;
    let (segments, seg) = run(&signal, &mut || 512);
    assert!(segments.is_empty());
    assert_eq!(seg.speech_ms_total(), 0);
}

#[test]
fn steady_hum_is_rejected() {
    let mut signal = bed(8_000, -70.0, 6);
    add_tone(&mut signal, 2_000, 8_000, 50.0, -20.0);
    let segments = run_fixed(&signal, 640);
    assert!(segments.is_empty(), "{}", segments.len());
    let mut without_check = Segmenter::new(SegmenterConfig {
        min_zero_crossing_rate: 0.0,
        ..SegmenterConfig::default()
    });
    let mut out = without_check.push(0, &signal);
    out.extend(without_check.flush());
    assert!(
        !out.is_empty(),
        "hum should only be rejected by the zero crossing check"
    );
}

#[test]
fn noise_floor_jump_recovers_and_still_hears_speech() {
    let mut quiet = bed(3_000, -60.0, 7);
    let loud = bed(12_000, -30.0, 8);
    quiet.extend(loud);
    add_speech(&mut quiet, 10_000, 12_000, -16.0, None);
    let segments = run_fixed(&quiet, 800);
    for s in &segments {
        let start = ms_of(s.start_sample);
        let end = ms_of(s.end_sample());
        if start < 9_000.0 {
            assert!(end < 3_000.0 + 5_500.0, "false segment ran to {end}");
        }
    }
    assert!(
        segments
            .iter()
            .any(|s| ms_of(s.start_sample) <= 10_100.0 && ms_of(s.end_sample()) >= 11_800.0),
        "speech after the jump was missed"
    );
}

#[test]
fn forced_cut_lands_in_quietest_window_and_carries_remainder() {
    let mut signal = bed(34_000, -60.0, 9);
    add_speech(&mut signal, 1_000, 22_980, -20.0, Some(-42.0));
    add_speech(&mut signal, 23_100, 31_000, -20.0, Some(-42.0));
    let segments = run_fixed(&signal, 1_600);
    assert_eq!(
        segments.len(),
        2,
        "{:?}",
        segments
            .iter()
            .map(|s| (ms_of(s.start_sample), ms_of(s.end_sample())))
            .collect::<Vec<_>>()
    );
    let cut = ms_of(segments[0].end_sample());
    assert!((22_980.0..=23_120.0).contains(&cut), "cut at {cut}");
    assert_eq!(segments[0].end_sample(), segments[1].start_sample);
    assert!(segments[0].samples.len() <= 25_000 * PER_MS);
    assert_exact(&signal, &segments);
}

#[test]
fn chunking_does_not_change_output_and_accounting_is_exact() {
    let mut rng = Rng::new(10);
    let mut signal = bed(60_000, -55.0, 11);
    let mut t = 500;
    while t < 58_000 {
        let len = 150 + rng.below(4_000) as usize;
        let level = -40.0 + rng.below(25) as f32;
        add_speech(&mut signal, t, (t + len).min(59_000), level, None);
        t += len + 100 + rng.below(3_000) as usize;
    }
    signal[123_456] = f32::NAN;
    let mut clean = signal.clone();
    clean[123_456] = 0.0;
    let reference = run_fixed(&signal, SAMPLE_RATE as usize * 60);
    assert!(reference.len() >= 5, "{}", reference.len());
    assert_exact(&clean, &reference);
    for seed in 0..5 {
        let mut rng = Rng::new(100 + seed);
        let (segments, seg) = run(&signal, &mut || 1 + rng.below(5_000) as usize);
        assert_eq!(segments, reference, "seed {seed}");
        let total: u64 = segments.iter().map(|s| s.speech_ms).sum();
        assert_eq!(seg.speech_ms_total(), total);
    }
}

#[test]
fn open_snapshot_tracks_current_speech() {
    let mut signal = bed(4_000, -60.0, 12);
    add_speech(&mut signal, 1_000, 2_600, -20.0, None);
    let mut seg = Segmenter::new(SegmenterConfig::default());
    assert!(seg.push(0, &signal[..800 * PER_MS]).is_empty());
    assert!(seg.open_snapshot().is_none());
    assert!(
        seg.push(800 * PER_MS as u64, &signal[800 * PER_MS..1_500 * PER_MS])
            .is_empty()
    );
    let (start, samples) = seg.open_snapshot().expect("open segment");
    assert!(ms_of(start) <= 1_000.0);
    assert_eq!(start as usize + samples.len(), 1_500 * PER_MS);
    assert!(seg.noise_floor_db().is_some_and(|f| f < -50.0));
    let closed = seg.push(1_500 * PER_MS as u64, &signal[1_500 * PER_MS..]);
    assert_eq!(closed.len(), 1);
    assert!(seg.open_snapshot().is_none());
}

#[test]
fn gaps_overlaps_and_odd_input() {
    let mut signal = bed(4_000, -60.0, 13);
    add_speech(&mut signal, 500, 1_800, -20.0, None);
    let mut seg = Segmenter::new(SegmenterConfig::default());
    let mut out = seg.push(0, &signal[..1_000 * PER_MS]);
    out.extend(seg.push(500 * PER_MS as u64, &signal[500 * PER_MS..1_200 * PER_MS]));
    out.extend(seg.push(3_000 * PER_MS as u64, &signal[3_000 * PER_MS..]));
    assert_eq!(out.len(), 1);
    assert_exact(&signal, &out);
    assert!(ms_of(out[0].end_sample()) <= 1_200.0);
    out.extend(seg.push(0, &signal[..100]));
    out.extend(seg.push(u64::MAX - 10, &[0.5; 100]));
    out.extend(seg.push(0, &[]));
    out.extend(seg.push(5, &[f32::INFINITY, f32::NEG_INFINITY, f32::NAN]));
    out.extend(seg.flush());
    out.extend(seg.flush());
    assert_eq!(out.len(), 1);
}

#[test]
fn memory_stays_bounded_over_long_input() {
    let mut seg = Segmenter::new(SegmenterConfig::default());
    let mut rng = Rng::new(14);
    let frame = 320;
    let mut index = 0u64;
    let mut emitted = 0usize;
    for second in 0..300u64 {
        let mut chunk = vec![0f32; SAMPLE_RATE as usize];
        for (i, s) in chunk.iter_mut().enumerate() {
            let t = (index as usize + i) as f32 / SAMPLE_RATE as f32;
            let syllable = ((index as usize + i) / (PER_MS * 100)) % 4 != 3;
            let tone = if syllable {
                0.1 * (2.0 * std::f32::consts::PI * 440.0 * t).sin()
            } else {
                0.0
            };
            *s = tone + rng.signed() * 0.001;
        }
        emitted += seg.push(index, &chunk).len();
        index += chunk.len() as u64;
        let open = seg.open.as_ref().map(|o| o.samples.len()).unwrap_or(0);
        assert!(
            open <= 25_000 * PER_MS + frame,
            "second {second}: open {open}"
        );
        assert!(seg.history.len() <= 240 * PER_MS);
        assert!(seg.minima.len() <= 151);
        assert!(seg.pending.len() < frame);
    }
    assert!(emitted >= 10, "{emitted}");
}

#[test]
fn hostile_configs_do_not_panic() {
    let configs = [
        SegmenterConfig {
            frame_ms: 0,
            max_segment_ms: 0,
            cut_search_ms: u32::MAX,
            cut_window_ms: 0,
            close_silence_ms: 0,
            floor_window_ms: 0,
            ..SegmenterConfig::default()
        },
        SegmenterConfig {
            frame_ms: u32::MAX,
            pre_roll_ms: u32::MAX / 1000,
            floor_rise: f32::NAN,
            ..SegmenterConfig::default()
        },
    ];
    let mut signal = bed(3_000, -60.0, 15);
    add_speech(&mut signal, 500, 2_500, -20.0, None);
    for config in configs {
        let mut seg = Segmenter::new(config);
        let mut out = seg.push(0, &signal);
        out.extend(seg.flush());
        assert_exact(&signal, &out);
    }
}

fn run_with(config: SegmenterConfig, signal: &[f32]) -> Vec<SpeechSegment> {
    let mut seg = Segmenter::new(config);
    let mut out = Vec::new();
    for (k, chunk) in signal.chunks(480).enumerate() {
        out.extend(seg.push((k * 480) as u64, chunk));
    }
    out.extend(seg.flush());
    out
}

#[test]
fn a_quiet_voice_across_a_silent_room_is_heard_on_the_microphone() {
    // a -68 dBFS voice over a -95 dBFS room: under the default -60 dBFS gate, well over the room's floor
    let mut signal = bed(8_000, -95.0, 7);
    add_speech(&mut signal, 2_000, 6_000, -68.0, None);
    assert!(run_with(SegmenterConfig::default(), &signal).is_empty(), "the default gate misses it");
    let heard = run_with(SegmenterConfig::microphone(), &signal);
    assert_eq!(heard.len(), 1);
    assert!(heard[0].speech_ms >= 2_400, "speech {}", heard[0].speech_ms);
    assert_exact(&signal, &heard);
}

#[test]
fn the_microphone_gate_changes_nothing_in_a_noisy_room() {
    // over a -50 dBFS bed the floor-relative rule decides, so both configs cut the same segments
    let mut signal = bed(8_000, -50.0, 3);
    add_speech(&mut signal, 2_000, 6_000, -38.0, None);
    let a = run_with(SegmenterConfig::default(), &signal);
    let b = run_with(SegmenterConfig::microphone(), &signal);
    assert_eq!(a, b);
    assert_eq!(a.len(), 1);
}

#[test]
fn microphone_segments_are_cut_at_18_seconds() {
    // 40 s of continuous speech: the default cuts at 25 s, the microphone at 18 s
    let mut signal = bed(42_000, -60.0, 11);
    add_speech(&mut signal, 1_000, 41_000, -30.0, None);
    let long = |segs: &[SpeechSegment]| segs.iter().map(|s| s.samples.len() / PER_MS).max().unwrap_or(0);
    let mic = run_with(SegmenterConfig::microphone(), &signal);
    let default = run_with(SegmenterConfig::default(), &signal);
    assert!(mic.len() >= 2, "{} microphone segments", mic.len());
    assert!(long(&mic) <= 18_000, "longest microphone segment {} ms", long(&mic));
    assert!(long(&default) > 18_000 && long(&default) <= 25_000, "longest default segment {} ms", long(&default));
    assert_exact(&signal, &mic);
}
