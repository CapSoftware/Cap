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
    ]
}

const FPS: u32 = 30;
const RES: (u32, u32) = (320, 180);

fn export_case(spec: &FixtureSpec, variant: &Variant, path: ExportPath) -> Option<String> {
    let id = format!("audio/{}/{}/{}{FPS}", spec.name, variant.edit, path.label());
    if !report::selected(&id) {
        return None;
    }
    let project = audio_support::project(spec);
    let rt = common::runtime();
    let mut config = project.config();
    (variant.apply)(&mut config);
    let mut case = Case::new(&id);
    let dir = common::scratch_dir(&id);
    match rt.block_on(audio_support::export(
        &project,
        config.clone(),
        path,
        FPS,
        RES,
        dir.path(),
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
                let model = audio_support::audio_model(&project, &config);
                match audio_support::exported_mono(&out) {
                    Err(e) => case.problem("error", e),
                    Ok(mono) => {
                        let report = audio_support::check_pcm(&mut case, "export", &model, &mono);
                        let frames = common::read_output(&out);
                        let video = project.model(&config);
                        common::check_sequence(&mut case, &video, &frames, FPS, true);
                        audio_support::check_av(&mut case, &project.meta, &report, &frames, FPS);
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
