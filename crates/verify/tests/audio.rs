//! Audio oracle: every mic, system audio and music marker must be heard
//! exactly once, at the time and level the reference audio model computes,
//! in exports and in offline editor playback, and in sync with the video.

mod audio_support;
mod common;

use audio_support::{ExportPath, OfflinePlayer};
use cap_project::{ClipSpeedAudioMode, ProjectConfiguration};
use cap_verify::{
    audio_fixture,
    audio_model::{self, AudioModel},
    fixture::FixtureSpec,
    report::{self, Case, Tier},
};

struct Variant {
    edit: &'static str,
    apply: fn(&mut ProjectConfiguration),
}

fn full(_: &mut ProjectConfiguration) {}

/// Cuts, a backward jump (1.0-2.0 plays again after 3.4-5.0) and a skip.
fn cuts(config: &mut ProjectConfiguration) {
    common::set_cuts(
        config,
        &[
            (0.5, 2.6, 1.0),
            (3.4, 5.0, 1.0),
            (1.0, 2.0, 1.0),
            (5.5, 7.8, 1.0),
        ],
    );
}

fn speeds(config: &mut ProjectConfiguration, mode: Option<ClipSpeedAudioMode>) {
    common::set_cuts(
        config,
        &[
            (0.3, 2.0, 1.0),
            (2.0, 4.0, 2.0),
            (4.0, 5.0, 0.5),
            (5.0, 7.0, 1.5),
            (7.0, 7.8, 1.0),
        ],
    );
    for segment in &mut config.timeline.as_mut().expect("timeline").segments {
        segment.speed_audio_mode = mode;
    }
}

/// Retimed segments in the default speed audio mode are silent.
fn speeds_muted(config: &mut ProjectConfiguration) {
    speeds(config, None);
}

/// Retimed segments resampled like tape (markers compressed in time).
fn speeds_match(config: &mut ProjectConfiguration) {
    speeds(config, Some(ClipSpeedAudioMode::MatchSpeed));
}

/// Mic at -6 dB, system audio at the -30 dB mute floor, clip volume 0.5 on
/// the second segment and 0 on the third.
fn levels(config: &mut ProjectConfiguration) {
    common::set_cuts(config, &[(0.2, 3.0, 1.0), (3.0, 5.5, 1.0), (5.5, 7.8, 1.0)]);
    config.audio.mic_volume_db = -6.0;
    config.audio.system_volume_db = -30.0;
    let segments = &mut config.timeline.as_mut().expect("timeline").segments;
    segments[1].volume = Some(0.5);
    segments[2].volume = Some(0.0);
}

/// Project mute: recording audio silent, timeline music still plays.
fn muted_with_music(config: &mut ProjectConfiguration) {
    config.audio.mute = true;
    audio_fixture::add_music(config, 1.0, 7.0, 0.5, -6.0);
}

/// Music on top of cuts: music follows output time, not the edits.
fn music_over_cuts(config: &mut ProjectConfiguration) {
    cuts(config);
    audio_fixture::add_music(config, 0.75, 6.5, 2.0, -3.0);
}

fn studio_sound(config: &mut ProjectConfiguration) {
    cuts(config);
    config.audio.improve = true;
}

fn transition(config: &mut ProjectConfiguration) {
    common::set_cuts(config, &[(0.3, 3.5, 1.0), (4.5, 7.8, 1.0)]);
    common::add_transition(config, 1, 0.4);
}

/// A long cross-fade: markers early in the overlap must keep the outgoing
/// clip's level and the incoming clip must ramp up (equal-power gains).
fn long_crossfade(config: &mut ProjectConfiguration) {
    common::set_cuts(config, &[(0.3, 4.1, 1.0), (3.9, 7.8, 1.0)]);
    common::add_transition(config, 1, 1.8);
}

/// A long fade through black: each side fades linearly to silence over half
/// the overlap.
fn long_fade_black(config: &mut ProjectConfiguration) {
    long_crossfade(config);
    config.timeline.as_mut().expect("timeline").transitions[0].kind =
        cap_project::ClipTransitionType::FadeThroughBlack;
}

fn variants() -> Vec<Variant> {
    vec![
        Variant {
            edit: "full",
            apply: full,
        },
        Variant {
            edit: "cuts",
            apply: cuts,
        },
        Variant {
            edit: "speeds-muted",
            apply: speeds_muted,
        },
        Variant {
            edit: "speeds-match",
            apply: speeds_match,
        },
        Variant {
            edit: "levels",
            apply: levels,
        },
        Variant {
            edit: "muted-music",
            apply: muted_with_music,
        },
        Variant {
            edit: "music-cuts",
            apply: music_over_cuts,
        },
        Variant {
            edit: "studio-sound",
            apply: studio_sound,
        },
        Variant {
            edit: "transition",
            apply: transition,
        },
        Variant {
            edit: "long-crossfade",
            apply: long_crossfade,
        },
        Variant {
            edit: "long-fade-black",
            apply: long_fade_black,
        },
    ]
}

const FPS: u32 = 30;
const RES: (u32, u32) = (320, 180);

fn export_case(spec: &FixtureSpec, variant: &Variant, path: ExportPath) -> Option<String> {
    export_case_at(spec, variant, path, FPS, None)
}

fn export_case_at(
    spec: &FixtureSpec,
    variant: &Variant,
    path: ExportPath,
    fps: u32,
    video_encoder_failure_at: Option<u32>,
) -> Option<String> {
    let id = format!("audio/{}/{}/{}{fps}", spec.name, variant.edit, path.label());
    if !report::selected(&id) {
        return None;
    }
    let project = audio_support::project(spec);
    let rt = common::runtime();
    let mut config = project.config();
    (variant.apply)(&mut config);
    let mut case = Case::new(&id);
    let dir = common::scratch_dir(&id);
    match rt.block_on(audio_support::export_failing_encoder_at(
        &project,
        config.clone(),
        path,
        fps,
        RES,
        dir.path(),
        video_encoder_failure_at,
    )) {
        Err(e) => case.problem("error", format!("export failed: {e}")),
        Ok(out) => match path {
            ExportPath::Gif => {
                if audio_support::has_audio_stream(&out) {
                    case.problem("audio-unexpected", "GIF export has an audio stream");
                }
            }
            ExportPath::Mov if !audio_support::has_audio_stream(&out) => {
                case.note(
                    "MOV export carries no audio (the app uses MOV for cursor-only overlays)",
                );
            }
            _ => {
                // libx264 tags its stream with a version SEI; the restarted
                // export must come from it.
                if video_encoder_failure_at.is_some()
                    && !std::fs::read(&out)
                        .is_ok_and(|bytes| bytes.windows(11).any(|w| w == b"x264 - core"))
                {
                    case.problem(
                        "error",
                        "export after the video encoder failed was not encoded by libx264",
                    );
                }
                let model = audio_support::audio_model(&project, &config);
                match audio_support::exported_mono(&out) {
                    Err(e) => case.problem("error", e),
                    Ok(mono) => {
                        let report = audio_support::check_pcm(&mut case, "export", &model, &mono);
                        let video = project.model(&config);
                        let frames =
                            common::read_output(&out, Some(&|i| video.expect(i as u32, fps)));
                        common::check_sequence(&mut case, &video, &frames, fps, true);
                        audio_support::check_av(&mut case, &project.meta, &report, &frames, fps);
                        // The audio track must cover the whole video, and end
                        // within one AAC frame (encoder padding) after it.
                        let audio_secs = mono.len() as f64 / f64::from(audio_model::ANALYSIS_RATE);
                        let video_secs = frames.len() as f64 / f64::from(fps);
                        let slack = 1024.0 / f64::from(audio_model::ANALYSIS_RATE) + 0.001;
                        if audio_secs < video_secs - 0.002 || audio_secs > video_secs + slack {
                            case.problem(
                                "audio-duration",
                                format!(
                                    "audio track lasts {audio_secs:.4} s, video {video_secs:.4} s (slack {slack:.4} s)"
                                ),
                            );
                        }
                    }
                }
            }
        },
    }
    report::settle(case).err()
}

fn run_exports(spec: FixtureSpec, variants: &[Variant], paths: &[ExportPath]) {
    let mut failures = Vec::new();
    for variant in variants {
        for &path in paths {
            failures.extend(export_case(&spec, variant, path));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn export_mp4() {
    run_exports(
        audio_fixture::mix(report::tier()),
        &variants(),
        &[ExportPath::App, ExportPath::Plain],
    );
}

/// Studio Sound at 10 fps (`cap export --fps 10`). The cuts' backward jump
/// sends the export through the editor's `AudioRenderer` instead of the
/// streaming mixer, and at 10 fps every video frame asks it for 4800
/// samples: more than one 4096-sample Studio Sound block, so the blocks
/// after the first in a request must line up too.
#[test]
fn export_studio_sound_low_fps() {
    let failures: Vec<String> = export_case_at(
        &audio_fixture::mix(report::tier()),
        &Variant {
            edit: "studio-sound",
            apply: studio_sound,
        },
        ExportPath::App,
        10,
        None,
    )
    .into_iter()
    .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// A hardware video encoder can fail mid-export when the media engine is
/// busy or resets (VideoToolbox error -19092 on shared macOS runners). The
/// export restarts on libx264 and must still match the audio and video
/// models, on the streaming (app) and in-memory (plain) audio paths.
#[test]
fn encoder_fallback() {
    let spec = audio_fixture::mix(report::tier());
    let variant = Variant {
        edit: "encoder-fallback",
        apply: full,
    };
    let failures: Vec<String> = [ExportPath::App, ExportPath::Plain]
        .into_iter()
        .filter_map(|path| export_case_at(&spec, &variant, path, FPS, Some(FPS * 3)))
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn studio_sound_music() {
    let spec = audio_fixture::mix(report::tier());
    let project = audio_support::project(&spec);
    let rt = common::runtime();
    let mut config = project.config();
    studio_sound(&mut config);
    audio_fixture::add_music(&mut config, 1.0, 7.0, 0.5, -6.0);
    let mut recording_config = config.clone();
    recording_config
        .timeline
        .as_mut()
        .expect("timeline")
        .audio_segments
        .clear();
    let mut failures = Vec::new();
    for fps in [30, 10] {
        for path in [ExportPath::App, ExportPath::Plain] {
            let id = format!(
                "audio/{}/studio-sound-music/{}{fps}",
                spec.name,
                path.label()
            );
            if !report::selected(&id) {
                continue;
            }
            let mut case = Case::new(&id);
            let combined_dir = common::scratch_dir(&id);
            let recording_dir = common::scratch_dir(&format!("{id}-recording"));
            let outputs: Result<Vec<Vec<f32>>, String> = [
                (config.clone(), combined_dir.path()),
                (recording_config.clone(), recording_dir.path()),
            ]
            .into_iter()
            .map(|(config, dir)| {
                rt.block_on(audio_support::export(&project, config, path, fps, RES, dir))
                    .and_then(|out| audio_support::exported_mono(&out))
            })
            .collect();
            match outputs {
                Ok(outputs) => audio_support::check_music_contribution(
                    &mut case,
                    &project,
                    &config,
                    &outputs[1],
                    &outputs[0],
                ),
                Err(error) => case.problem("error", error),
            }
            failures.extend(report::settle(case).err());
        }
    }
    let id = format!("audio/{}/studio-sound-music/playback", spec.name);
    if report::selected(&id) {
        let mut case = Case::new(&id);
        let duration = audio_support::audio_model(&project, &config).duration;
        let mut outputs = Vec::new();
        for config in [config.clone(), recording_config] {
            let mut player = OfflinePlayer::open(&rt, &project, config);
            player.play(0.0);
            outputs.push(audio_support::mono(&player.pull(duration + 0.3)));
            if player.starved > 0 {
                case.problem("audio-starved", format!("{} pulls starved", player.starved));
            }
        }
        audio_support::check_music_contribution(
            &mut case,
            &project,
            &config,
            &outputs[1],
            &outputs[0],
        );
        failures.extend(report::settle(case).err());
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn studio_sound_music_is_additive() {
    let spec = audio_fixture::mix(report::tier());
    let id = format!("audio/{}/studio-sound-music/additive", spec.name);
    if !report::selected(&id) {
        return;
    }
    let project = audio_support::project(&spec);
    let rt = common::runtime();
    let mut config = project.config();
    cuts(&mut config);
    audio_fixture::add_music(&mut config, 1.0, 7.0, 0.5, -6.0);
    let media = rt
        .block_on(cap_editor::create_segments(
            &project.meta,
            project.meta.studio_meta().expect("studio"),
            false,
        ))
        .expect("segments");
    let segments = rt.block_on(cap_editor::get_audio_segments(&media));
    let music = cap_editor::load_music_tracks_uncached(&config, &project.path);
    let source = cap_audio::AudioData::from_file(project.path.join(audio_fixture::MUSIC_FILE))
        .expect("music source");
    assert_eq!(source.channels(), 2);
    let frames =
        (config.timeline.as_ref().expect("timeline").duration() * 48_000.0).round() as usize;
    let render = |config: &ProjectConfiguration, block: usize| {
        let mut renderer =
            cap_editor::AudioRenderer::new(segments.clone()).with_music(music.clone());
        let mut pcm = Vec::new();
        while pcm.len() / 2 < frames {
            let count = block.min(frames - pcm.len() / 2);
            let (_, chunk) = renderer.render_frame_raw(count, config).expect("audio");
            assert!(!chunk.is_empty());
            pcm.extend(chunk);
        }
        pcm
    };
    let mut case = Case::new(&id);
    for improve in [false, true] {
        config.audio.improve = improve;
        let mut recording_config = config.clone();
        recording_config
            .timeline
            .as_mut()
            .expect("timeline")
            .audio_segments
            .clear();
        for block in [1024, 1600, 4800] {
            let combined = render(&config, block);
            let recording = render(&recording_config, block);
            assert_eq!(combined.len(), recording.len());
            let mut worst = 0.0f32;
            for (sample, (combined, recording)) in combined.iter().zip(&recording).enumerate() {
                assert!(combined.is_finite() && combined.abs() < 0.99);
                let frame = sample / 2;
                let expected = if (48_000..336_000).contains(&frame) {
                    source.samples()[(frame - 24_000) * 2 + sample % 2] * 10.0_f32.powf(-6.0 / 20.0)
                } else {
                    0.0
                };
                let difference = (combined - recording - expected).abs();
                worst = worst.max(difference);
                assert!(
                    difference <= 1e-6,
                    "Studio Sound {improve}, block {block}, sample {sample}: music differs by {difference}"
                );
            }
            case.note(format!(
                "Studio Sound {improve}, block {block}: music max sample error {worst:.9}"
            ));
        }
    }
    common::finish(case);
}

/// Full decode of audio recorded at another rate than 48 kHz (44.1 kHz USB
/// microphones are common): the resampler's buffered tail must be flushed,
/// so the decoded track lasts exactly as long as the source, its last
/// milliseconds still carry the signal, and every sample sits at its time.
#[test]
fn resampled_decode_tail() {
    const TONE_HZ: f64 = 1000.0;
    const AMPLITUDE: f64 = 0.5;
    let mut failures = Vec::new();
    for rate in [44_100u32, 32_000] {
        let id = format!("audio/decode/resample-{rate}/tail");
        if !report::selected(&id) {
            continue;
        }
        let mut case = Case::new(&id);
        let dir = common::scratch_dir(&id);
        let path = dir.path().join("tone.wav");
        let frames = rate as usize;
        let tone: Vec<i16> = (0..frames)
            .map(|n| {
                let t = n as f64 / f64::from(rate);
                (AMPLITUDE * (2.0 * std::f64::consts::PI * TONE_HZ * t).sin() * 32767.0).round()
                    as i16
            })
            .collect();
        write_wav_mono(&path, rate, &tone);
        match cap_audio::AudioData::from_file(&path) {
            Err(e) => case.problem("error", format!("decode: {e}")),
            Ok(data) => {
                let channels = usize::from(data.channels());
                let mono: Vec<f64> = data
                    .samples()
                    .chunks(channels)
                    .map(|c| f64::from(c[0]))
                    .collect();
                let expected_len = frames * 48_000 / rate as usize;
                if mono.len().abs_diff(expected_len) > 2 {
                    case.problem(
                        "duration",
                        format!(
                            "decoded {} samples at 48 kHz, the {frames}-sample {rate} Hz source lasts {expected_len} ({:+.2} ms)",
                            mono.len(),
                            (mono.len() as f64 - expected_len as f64) / 48.0
                        ),
                    );
                }
                let ideal = |m: usize| {
                    AMPLITUDE * (2.0 * std::f64::consts::PI * TONE_HZ * m as f64 / 48_000.0).sin()
                };
                let worst = (4_800..mono.len().min(expected_len).saturating_sub(4_800))
                    .map(|m| ((mono[m] - ideal(m)).abs(), m))
                    .max_by(|a, b| a.0.total_cmp(&b.0));
                if let Some((error, m)) = worst
                    && error > 0.02
                {
                    case.problem(
                        "timing",
                        format!(
                            "sample {m} ({:.3} s) is {error:.3} away from the source tone at that time",
                            m as f64 / 48_000.0
                        ),
                    );
                }
                let tail = 240.min(mono.len());
                let rms = (mono[mono.len() - tail..].iter().map(|v| v * v).sum::<f64>()
                    / tail.max(1) as f64)
                    .sqrt();
                let tone_rms = AMPLITUDE / std::f64::consts::SQRT_2;
                if rms < 0.6 * tone_rms {
                    case.problem(
                        "duration",
                        format!(
                            "the last 5 ms are {:.1} dB below the tone (rms {rms:.3}, tone {tone_rms:.3})",
                            20.0 * (rms / tone_rms).log10()
                        ),
                    );
                }
                case.note(format!(
                    "{} samples (expected {expected_len}), worst interior error {:.4}, tail rms {rms:.3}",
                    mono.len(),
                    worst.map_or(0.0, |w| w.0)
                ));
            }
        }
        if let Err(message) = report::settle(case) {
            failures.push(message);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// A 16-bit PCM mono WAV file.
fn write_wav_mono(path: &std::path::Path, rate: u32, samples: &[i16]) {
    let data_len = (samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + data_len as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&rate.to_le_bytes());
    bytes.extend_from_slice(&(rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::write(path, bytes).expect("write wav");
}

#[test]
fn export_other_formats() {
    run_exports(
        audio_fixture::mix(report::tier()),
        &[Variant {
            edit: "cuts",
            apply: cuts,
        }],
        &[ExportPath::Mov, ExportPath::Gif],
    );
}

#[test]
fn export_multi_clip() {
    run_exports(
        audio_fixture::multi(report::tier()),
        &[
            Variant {
                edit: "full",
                apply: full,
            },
            Variant {
                edit: "reorder",
                apply: |config| {
                    let timeline = config.timeline.as_mut().expect("timeline");
                    timeline.segments.reverse();
                },
            },
        ],
        &[ExportPath::App, ExportPath::Plain],
    );
}

/// Plays the whole timeline from 0 through the offline output.
fn playback_case(spec: &FixtureSpec, variant: &Variant) -> Option<String> {
    let id = format!("audio/{}/{}/playback", spec.name, variant.edit);
    if !report::selected(&id) {
        return None;
    }
    let project = audio_support::project(spec);
    let rt = common::runtime();
    let mut config = project.config();
    (variant.apply)(&mut config);
    let model = audio_support::audio_model(&project, &config);
    let mut case = Case::new(&id);
    let mut player = OfflinePlayer::open(&rt, &project, config);
    player.play(0.0);
    let pcm = player.pull(model.duration + 0.3);
    audio_support::check_pcm(
        &mut case,
        "play from 0",
        &model.window(0.0, audio_support::frames_secs(&pcm)),
        &audio_support::mono(&pcm),
    );
    if player.starved > 0 {
        case.problem(
            "audio-starved",
            format!("{} pulls starved (samples never rendered)", player.starved),
        );
    }
    report::settle(case).err()
}

#[test]
fn playback() {
    let spec = audio_fixture::mix(report::tier());
    let failures: Vec<String> = variants()
        .iter()
        .filter_map(|variant| playback_case(&spec, variant))
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn playback_multi_clip() {
    let spec = audio_fixture::multi(report::tier());
    let failures: Vec<String> = [Variant {
        edit: "full",
        apply: full,
    }]
    .iter()
    .filter_map(|variant| playback_case(&spec, variant))
    .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// One play/seek script step.
#[derive(Clone, Copy, Debug)]
enum Step {
    /// Press play at a timeline position (a pause before it is implied).
    Play(f64),
    /// Live seek during playback.
    Seek(f64),
    /// Pull this many seconds of output.
    Pull(f64),
}

/// Runs a script; returns the output of every play/seek span as
/// (timeline start, interleaved PCM).
fn run_script(player: &mut OfflinePlayer, script: &[Step]) -> Vec<(f64, Vec<f32>)> {
    let mut spans: Vec<(f64, Vec<f32>)> = Vec::new();
    for step in script {
        match *step {
            Step::Play(at) => {
                player.play(at);
                spans.push((at, Vec::new()));
            }
            Step::Seek(to) => {
                player.seek(to);
                spans.push((to, Vec::new()));
            }
            Step::Pull(secs) => {
                let pcm = player.pull(secs);
                spans.last_mut().expect("pull after play").1.extend(pcm);
            }
        }
    }
    spans
}

fn span_model(model: &AudioModel, spans: &[(f64, Vec<f32>)]) -> Vec<AudioModel> {
    spans
        .iter()
        .map(|(start, pcm)| model.window(*start, audio_support::frames_secs(pcm)))
        .collect()
}

const SPAN: f64 = 1.2;

/// Pause/play and live seeks: every span is checked against the model, and
/// every span's PCM must equal what main's player produces for it: a play
/// equals a fresh output's first play at that position; a live seek keeps
/// reading the render the play started.
fn transport_case(
    spec: &FixtureSpec,
    edit: &str,
    apply: fn(&mut ProjectConfiguration),
) -> Option<String> {
    let id = format!("audio/{}/{edit}/transport", spec.name);
    if !report::selected(&id) {
        return None;
    }
    let project = audio_support::project(spec);
    let rt = common::runtime();
    let mut config = project.config();
    apply(&mut config);
    let model = audio_support::audio_model(&project, &config);
    let mut case = Case::new(&id);
    let script = [
        Step::Play(2.0),
        Step::Pull(SPAN),
        Step::Play(4.5),
        Step::Pull(SPAN),
        Step::Play(0.6),
        Step::Pull(SPAN),
        Step::Play(2.0),
        Step::Pull(SPAN),
        Step::Seek(5.2),
        Step::Pull(SPAN),
        Step::Seek(1.1),
        Step::Pull(SPAN),
    ];
    let mut player = OfflinePlayer::open(&rt, &project, config.clone());
    let spans = run_script(&mut player, &script);
    for ((start, pcm), expected) in spans.iter().zip(span_model(&model, &spans)) {
        audio_support::check_pcm(
            &mut case,
            &format!("span at {start:.2}s"),
            &expected,
            &audio_support::mono(pcm),
        );
    }
    // Reference PCM for every span from fresh outputs: a play is a fresh
    // play there; a seek target is read from the play it happened in.
    let mut play_start = 0.0;
    let mut offset_in_play = 0.0;
    let mut kinds = Vec::new();
    for step in &script {
        match *step {
            Step::Play(at) => {
                play_start = at;
                offset_in_play = 0.0;
                kinds.push((at, None));
            }
            Step::Seek(to) => kinds.push((to, Some((play_start, offset_in_play)))),
            Step::Pull(secs) => offset_in_play += secs,
        }
    }
    for ((start, pcm), (_, seek)) in spans.iter().zip(&kinds) {
        let mut fresh = OfflinePlayer::open(&rt, &project, config.clone());
        let reference = match seek {
            None => {
                fresh.play(*start);
                fresh.pull(audio_support::frames_secs(pcm))
            }
            Some((play_at, _)) => {
                fresh.play(*play_at);
                fresh.seek(*start);
                fresh.pull(audio_support::frames_secs(pcm))
            }
        };
        if seek.is_some() {
            let mut cold = OfflinePlayer::open(&rt, &project, config.clone());
            cold.play(*start);
            let cold = cold.pull(audio_support::frames_secs(pcm));
            case.note(match audio_model::pcm_difference(pcm, &cold) {
                None => format!("seek to {start:.2}s: also identical to a fresh play there"),
                Some((db, _)) => format!(
                    "seek to {start:.2}s: differs from a fresh play there by {db:.1} dBFS (main keeps the play's render)"
                ),
            });
        }
        let label = match seek {
            None => format!("play at {start:.2}s"),
            Some((play_at, _)) => format!("seek to {start:.2}s (play from {play_at:.2}s)"),
        };
        match audio_model::pcm_difference(pcm, &reference) {
            None => case.note(format!("{label}: PCM identical to a fresh output")),
            Some((db, at)) => case.problem("pcm-mismatch", format!(
                "{label}: PCM differs from a fresh output (peak difference {db:.1} dBFS, first at {:.4}s into the span)",
                (at / audio_support::CHANNELS) as f64 / f64::from(audio_support::RATE)
            )),
        }
    }
    if player.starved > 0 {
        case.problem("audio-starved", format!("{} pulls starved", player.starved));
    }
    report::settle(case).err()
}

#[test]
fn transport() {
    let spec = audio_fixture::mix(report::tier());
    let mut failures = Vec::new();
    failures.extend(transport_case(&spec, "full", full));
    failures.extend(transport_case(&spec, "studio-sound-full", |config| {
        config.audio.improve = true;
    }));
    if report::tier() == Tier::Full {
        failures.extend(transport_case(&spec, "cuts", cuts));
        failures.extend(transport_case(&spec, "studio-sound-cuts", studio_sound));
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The oracle itself: real playback PCM passes, and the same PCM with one
/// device block (10.7 ms) of inserted silence, one dropped block, a
/// repeated half second, a 6 ms shift (tolerance 5 ms) or a 6 dB drop on one source fails
/// with the right class.
#[test]
fn oracle_self_check() {
    let spec = audio_fixture::mix(report::tier());
    let id = format!("audio/{}/oracle-self-check", spec.name);
    if !report::selected(&id) {
        return;
    }
    let project = audio_support::project(&spec);
    let rt = common::runtime();
    let mut config = project.config();
    music_over_cuts(&mut config);
    let model = audio_support::audio_model(&project, &config);
    let mut player = OfflinePlayer::open(&rt, &project, config);
    player.play(0.0);
    let pcm = audio_support::mono(&player.pull(model.duration + 0.3));
    let model = model.window(0.0, pcm.len() as f64 / f64::from(audio_support::RATE));
    let at = |secs: f64| (secs * f64::from(audio_support::RATE)) as usize;
    let block = audio_support::BLOCK;
    let gap = {
        let mut v = pcm.clone();
        v.splice(at(3.0)..at(3.0), std::iter::repeat_n(0.0, block));
        v
    };
    let dropped = {
        let mut v = pcm.clone();
        v.drain(at(3.0)..at(3.0) + block);
        v
    };
    let repeated = {
        let mut v = pcm.clone();
        let copy = v[at(2.0)..at(2.5)].to_vec();
        v.splice(at(2.5)..at(2.5), copy);
        v
    };
    let shifted = {
        let mut v = vec![0.0; at(0.006)];
        v.extend_from_slice(&pcm);
        v
    };
    let mut case = Case::new(&id);
    let classes = |mono: &[f32]| {
        audio_model::check(&model, &audio_model::hear(mono, 0.0, &model.rate_windows)).classes()
    };
    let original = classes(&pcm);
    if !original.is_empty() {
        case.problem("error", format!("unmodified playback fails: {original:?}"));
    }
    for (label, mono, must) in [
        ("10.7 ms gap", &gap, "audio-timing"),
        ("10.7 ms drop", &dropped, "audio-timing"),
        ("0.5 s repeat", &repeated, "audio-unexpected"),
        ("6 ms shift", &shifted, "audio-timing"),
    ] {
        let found = classes(mono);
        if found.contains(&must) {
            case.note(format!("{label}: caught as {found:?}"));
        } else {
            case.problem(
                "error",
                format!("{label} not caught as {must} (classes {found:?})"),
            );
        }
    }
    let quiet = {
        let mut config = project.config();
        music_over_cuts(&mut config);
        config.audio.system_volume_db = -6.0;
        audio_support::audio_model(&project, &config)
    };
    let found = audio_model::check(
        &quiet.window(0.0, pcm.len() as f64 / f64::from(audio_support::RATE)),
        &audio_model::hear(&pcm, 0.0, &quiet.rate_windows),
    )
    .classes();
    if found.contains(&"audio-level") {
        case.note(format!("6 dB system level error: caught as {found:?}"));
    } else {
        case.problem(
            "error",
            format!("6 dB level error not caught (classes {found:?})"),
        );
    }
    common::finish(case);
}

/// Stereo system audio recorded on the left channel only must come out on
/// the left channel only. Every other case mixes identical channels and
/// checks the channel average, so it cannot see swapped or summed channels.
#[test]
fn stereo_channels() {
    use cap_verify::{
        audio_code::{self, AudioSource},
        fixture,
        media::{self, AudioCodec},
    };
    let id = format!("audio/stereo-left/full/{}{FPS}", ExportPath::App.label());
    if !report::selected(&id) {
        return;
    }
    common::init();
    let mut spec = audio_fixture::mix(report::tier());
    spec.name = format!("{}-left", spec.name);
    spec.segments[0].mic = None;
    let path = fixture::ensure_fixture(&spec, |spec, dir| {
        audio_fixture::write(spec, dir)?;
        let file = dir.join("content/segments/segment-0/system_audio.ogg");
        let decoded = media::decode_audio(&file, None)?;
        let left = decoded.channels[0].clone();
        let right = vec![0.0; left.len()];
        media::write_audio(
            &file,
            &[left, right],
            decoded.sample_rate,
            AudioCodec::Opus,
            96_000,
        )
    })
    .unwrap_or_else(|e| panic!("fixture {}: {e:?}", spec.name));
    let project = common::load(&spec.name, path);
    let config = project.config();
    let model = audio_support::audio_model(&project, &config);
    let required = model
        .expected
        .iter()
        .filter(|e| {
            e.source == AudioSource::System && e.presence == audio_model::Presence::Required
        })
        .count();
    let mut case = Case::new(&id);
    let dir = common::scratch_dir(&id);
    match common::runtime().block_on(audio_support::export(
        &project,
        config,
        ExportPath::App,
        FPS,
        RES,
        dir.path(),
    )) {
        Err(e) => case.problem("error", format!("export failed: {e}")),
        Ok(out) => match media::decode_audio(&out, Some(audio_model::ANALYSIS_RATE)) {
            Err(e) => case.problem("error", format!("decode audio: {e:?}")),
            Ok(decoded) if decoded.channels.len() != 2 => case.problem(
                "audio-channels",
                format!(
                    "export has {} audio channels, expected 2",
                    decoded.channels.len()
                ),
            ),
            Ok(decoded) => {
                let heard = |channel: &[f32]| {
                    audio_code::locate_markers(
                        channel,
                        audio_model::ANALYSIS_RATE,
                        AudioSource::System,
                    )
                    .into_iter()
                    .filter(|m| m.index.is_some() && m.gain > 0.02)
                    .count()
                };
                let (left, right) = (heard(&decoded.channels[0]), heard(&decoded.channels[1]));
                if left < required || right > 0 {
                    case.problem(
                        "audio-channels",
                        format!(
                            "left-only system audio: {left} markers heard on the left (expected {required}), {right} on the right (expected 0)"
                        ),
                    );
                }
            }
        },
    }
    common::finish(case);
}

/// A recording whose mic gap summary reports a stale startup burst: the
/// editor plays the mic earlier by the trimmed time (stale-startup repair),
/// in exports and in playback.
///
/// The trim is one whole marker period (500 ms), so the repaired mic markers
/// keep their own schedule phase and stay clear of the system-audio markers.
/// A 300 ms trim moved every mic marker to 33 ms after the start of the
/// system marker with the same index; the two overlapped for 87 ms and the
/// overlapped system marker sometimes failed to decode.
#[test]
fn timing_repair() {
    use cap_verify::fixture;
    const TRIMMED_MS: u32 = 500;
    common::init();
    let mut spec = audio_fixture::mix(report::tier());
    spec.name = format!("{}-repair{TRIMMED_MS}", spec.name);
    let path = fixture::ensure_fixture(&spec, |spec, dir| {
        audio_fixture::write(spec, dir)?;
        let meta_path = dir.join("recording-meta.json");
        let mut meta: serde_json::Value = serde_json::from_slice(&std::fs::read(&meta_path)?)?;
        meta["segments"][0]["mic"]["gap_summary"] = serde_json::json!({
            "total_overlap_trimmed_ms": TRIMMED_MS,
            "startup_overlap_trimmed_ms": TRIMMED_MS,
            "overlap_dropped_frames": 4,
            "startup_overlap_drops": 4
        });
        std::fs::write(&meta_path, serde_json::to_vec_pretty(&meta)?)?;
        Ok(())
    })
    .unwrap_or_else(|e| panic!("fixture {}: {e:?}", spec.name));
    let project = common::load(&spec.name, path);
    let config = project.config();
    let model = audio_support::audio_model(&project, &config);
    let mut failures = Vec::new();
    for path in [ExportPath::App, ExportPath::Plain] {
        let id = format!("audio/{}/full/{}{FPS}", spec.name, path.label());
        if !report::selected(&id) {
            continue;
        }
        let mut case = Case::new(&id);
        let dir = common::scratch_dir(&id);
        match common::runtime().block_on(audio_support::export(
            &project,
            config.clone(),
            path,
            FPS,
            RES,
            dir.path(),
        )) {
            Err(e) => case.problem("error", format!("export failed: {e}")),
            Ok(out) => match audio_support::exported_mono(&out) {
                Err(e) => case.problem("error", e),
                Ok(mono) => {
                    audio_support::check_pcm(&mut case, "export", &model, &mono);
                }
            },
        }
        if let Err(message) = report::settle(case) {
            failures.push(message);
        }
    }
    let id = format!("audio/{}/full/playback", spec.name);
    if report::selected(&id) {
        let rt = common::runtime();
        let mut case = Case::new(&id);
        let mut player = OfflinePlayer::open(&rt, &project, config);
        player.play(0.0);
        let pcm = player.pull(model.duration + 0.3);
        audio_support::check_pcm(
            &mut case,
            "play from 0",
            &model.window(0.0, audio_support::frames_secs(&pcm)),
            &audio_support::mono(&pcm),
        );
        if let Err(message) = report::settle(case) {
            failures.push(message);
        }
    }
    common::assert_passed(failures);
}
