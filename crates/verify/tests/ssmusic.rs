mod audio_support;
mod common;

use audio_support::{ExportPath, OfflinePlayer};
use cap_project::ProjectConfiguration;
use cap_verify::{audio_code::AudioSource, audio_fixture, audio_model, report::Tier};
use std::path::Path;

fn config(project: &common::Project, improve: bool, music: bool) -> ProjectConfiguration {
    let mut config = project.config();
    common::set_cuts(
        &mut config,
        &[
            (0.5, 2.6, 1.0),
            (3.4, 5.0, 1.0),
            (1.0, 2.0, 1.0),
            (5.5, 7.8, 1.0),
        ],
    );
    config.audio.improve = improve;
    if music {
        audio_fixture::add_music(&mut config, 1.0, 7.0, 0.5, -6.0);
    }
    config
}

fn raw(
    rt: &tokio::runtime::Runtime,
    project: &common::Project,
    config: &ProjectConfiguration,
    block: usize,
) -> Vec<f32> {
    let media = rt
        .block_on(cap_editor::create_segments(
            &project.meta,
            project.meta.studio_meta().unwrap(),
            false,
        ))
        .unwrap();
    let segments = rt.block_on(cap_editor::get_audio_segments(&media));
    let music = cap_editor::load_music_tracks_uncached(config, &project.path);
    let mut renderer = cap_editor::AudioRenderer::new(segments).with_music(music);
    let count = (config.timeline.as_ref().unwrap().duration() * 48000.0).round() as usize;
    let mut pcm = Vec::new();
    while pcm.len() / 2 < count {
        let request = block.min(count - pcm.len() / 2);
        let (_, frame) = renderer.render_frame_raw(request, config).unwrap();
        assert!(!frame.is_empty());
        pcm.extend(frame);
    }
    audio_support::mono(&pcm)
}

fn subtract(mix: &[f32], recording: &[f32]) -> Vec<f32> {
    assert_eq!(mix.len(), recording.len());
    mix.iter().zip(recording).map(|(a, b)| a - b).collect()
}

fn save(dir: &Path, name: &str, pcm: &[f32]) {
    let bytes: Vec<u8> = pcm.iter().flat_map(|v| v.to_le_bytes()).collect();
    std::fs::write(dir.join(format!("{name}.f32")), bytes).unwrap();
}

fn inspect(
    project: &common::Project,
    config: &ProjectConfiguration,
    pcm: &[f32],
    music_only: bool,
) -> serde_json::Value {
    let mut model = audio_support::audio_model(project, config);
    if music_only {
        model.expected.retain(|m| m.source == AudioSource::Media);
    }
    let heard = audio_model::hear(pcm, 0.0, &model.rate_windows);
    let result = audio_model::check(&model, &heard);
    serde_json::json!({"report": result, "heard": heard, "expected": model.expected})
}

#[test]
fn investigate_studio_sound_music() {
    let project = audio_support::project(&audio_fixture::mix(Tier::Fast));
    let rt = common::runtime();
    let dir = std::env::var_os("SSMUSIC_ARTIFACTS")
        .map(std::path::PathBuf::from)
        .unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    let mut evidence = serde_json::Map::new();
    for block in [1024, 1600, 4800] {
        let mut stems = Vec::new();
        for improve in [false, true] {
            let cfg = config(&project, improve, true);
            let mix = raw(&rt, &project, &cfg, block);
            let base = raw(&rt, &project, &config(&project, improve, false), block);
            let stem = subtract(&mix, &base);
            let key = format!("raw-{block}-{improve}");
            save(&dir, &format!("{key}-mix"), &mix);
            save(&dir, &format!("{key}-base"), &base);
            save(&dir, &format!("{key}-stem"), &stem);
            evidence.insert(key, serde_json::json!({"mix": inspect(&project, &cfg, &mix, false), "stem": inspect(&project, &cfg, &stem, true), "peak": mix.iter().copied().map(f32::abs).fold(0.0f32, f32::max)}));
            stems.push(stem);
        }
        let max = stems[0]
            .iter()
            .zip(&stems[1])
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        evidence.insert(format!("stem-change-{block}"), serde_json::json!(max));
        assert!(max < 1e-6, "music changed by {max}");
    }
    for improve in [false, true] {
        let cfg = config(&project, improve, true);
        let mut player = OfflinePlayer::open(&rt, &project, cfg.clone());
        player.play(0.0);
        let mix = audio_support::mono(&player.pull(7.0));
        let mut player = OfflinePlayer::open(&rt, &project, config(&project, improve, false));
        player.play(0.0);
        let base = audio_support::mono(&player.pull(7.0));
        let stem = subtract(&mix, &base);
        evidence.insert(format!("playback-{improve}"), serde_json::json!({"mix": inspect(&project, &cfg, &mix, false), "stem": inspect(&project, &cfg, &stem, true)}));
        save(&dir, &format!("playback-{improve}-mix"), &mix);
        save(&dir, &format!("playback-{improve}-base"), &base);
        for fps in [30, 10] {
            let export_dir = dir.join(format!("export-{fps}-{improve}"));
            std::fs::create_dir_all(&export_dir).unwrap();
            let out = rt
                .block_on(audio_support::export(
                    &project,
                    cfg.clone(),
                    ExportPath::App,
                    fps,
                    (320, 180),
                    &export_dir,
                ))
                .unwrap();
            let mix = audio_support::exported_mono(&out).unwrap();
            let base_dir = export_dir.join("baseline");
            std::fs::create_dir_all(&base_dir).unwrap();
            let out = rt
                .block_on(audio_support::export(
                    &project,
                    config(&project, improve, false),
                    ExportPath::App,
                    fps,
                    (320, 180),
                    &base_dir,
                ))
                .unwrap();
            let base = audio_support::exported_mono(&out).unwrap();
            let stem = subtract(&mix, &base);
            evidence.insert(format!("export-{fps}-{improve}"), serde_json::json!({"mix": inspect(&project, &cfg, &mix, false), "stem": inspect(&project, &cfg, &stem, true)}));
            save(&dir, &format!("export-{fps}-{improve}-mix"), &mix);
            save(&dir, &format!("export-{fps}-{improve}-base"), &base);
            save(&dir, &format!("export-{fps}-{improve}-stem"), &stem);
        }
    }
    let cfg = config(&project, true, true);
    let mut model = audio_support::audio_model(&project, &cfg);
    model
        .expected
        .retain(|marker| marker.source == AudioSource::Media);
    let stem = subtract(
        &raw(&rt, &project, &cfg, 1600),
        &raw(&rt, &project, &config(&project, true, false), 1600),
    );
    let first = model
        .expected
        .iter()
        .find(|m| m.presence == audio_model::Presence::Required)
        .unwrap();
    let mut missing = stem.clone();
    let start = (first.time_secs * 48000.0).round() as usize;
    missing[start..start + 5760].fill(0.0);
    let mut shifted = stem.clone();
    shifted.rotate_right(384);
    let source = cap_audio::AudioData::from_raw_f32(stem.clone(), 1);
    let enhanced = cap_audio::VoiceEnhancer::new(1)
        .render(&source, 0, stem.len())
        .samples()
        .to_vec();
    let corruptions = [
        ("missing", missing),
        ("shift-8ms", shifted),
        ("gain-plus29", stem.iter().map(|s| s * 1.29).collect()),
        ("duck-minus29", stem.iter().map(|s| s * 0.71).collect()),
        ("voice-enhanced-music", enhanced),
    ];
    for (name, corrupted) in corruptions {
        let report = audio_model::check(&model, &audio_model::hear(&corrupted, 0.0, &[]));
        assert!(!report.passed(), "missed {name}");
        evidence.insert(
            format!("corruption-{name}"),
            serde_json::json!({"report": report}),
        );
    }
    std::fs::write(
        dir.join("evidence.json"),
        serde_json::to_vec_pretty(&evidence).unwrap(),
    )
    .unwrap();
}
