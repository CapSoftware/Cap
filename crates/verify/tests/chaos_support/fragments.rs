//! Fragment chaos for crash recovery and Instant finalization: a short
//! fragmented recording made by the product's segmented muxers, copied per
//! probe and damaged (missing or truncated init segments and fragments,
//! garbage manifests), then recovered or finalized like the app.

use std::{path::Path, sync::Arc, time::Duration};

use anyhow::{Context, anyhow};
use cap_media_info::{AudioInfo, RawVideoFormat, Sample, Type, VideoInfo};
use cap_recording::{
    AudioFrame, ChannelAudioSource, ChannelAudioSourceConfig, ChannelVideoSource,
    ChannelVideoSourceConfig, OutputPipeline,
    ffmpeg::{
        DashSegmentedAudioMuxer, DashSegmentedAudioMuxerConfig, FFmpegVideoFrame,
        FragmentedAudioMuxer, FragmentedAudioMuxerConfig, SegmentedVideoMuxer,
        SegmentedVideoMuxerConfig,
    },
    recovery::RecoveryManager,
};
use cap_timestamp::{Timestamp, Timestamps};
use serde_json::json;

use super::{
    harness::{Ctx, Probe, Verdict},
    project::copy_dir,
};

const SECONDS: f64 = 4.5;
const FPS: u32 = 30;

/// Records the fixture: `studio/` (an in-progress fragmented Studio
/// recording) and `instant/` (Instant's display and audio fragments).
async fn record(dir: &Path) -> anyhow::Result<()> {
    let studio = dir.join("studio");
    let segment = studio.join("content/segments/segment-0");
    let instant = dir.join("instant/content");
    std::fs::create_dir_all(&segment)?;
    std::fs::create_dir_all(&instant)?;
    let timestamps = Timestamps::now();
    let info = VideoInfo::from_raw(RawVideoFormat::Bgra, 320, 180, FPS);
    let (vtx, vrx) = flume::bounded::<FFmpegVideoFrame>(64);
    let video = OutputPipeline::builder(segment.join("display"))
        .with_video::<ChannelVideoSource<FFmpegVideoFrame>>(ChannelVideoSourceConfig::new(
            info, vrx,
        ))
        .with_timestamps(timestamps)
        .build::<SegmentedVideoMuxer>(SegmentedVideoMuxerConfig {
            segment_duration: Duration::from_secs(2),
            ..Default::default()
        })
        .await
        .map_err(|e| anyhow!("display pipeline: {e:#}"))?;
    let (ivtx, ivrx) = flume::bounded::<FFmpegVideoFrame>(64);
    let instant_video = OutputPipeline::builder(instant.join("display"))
        .with_video::<ChannelVideoSource<FFmpegVideoFrame>>(ChannelVideoSourceConfig::new(
            info, ivrx,
        ))
        .with_timestamps(timestamps)
        .build::<SegmentedVideoMuxer>(SegmentedVideoMuxerConfig {
            segment_duration: Duration::from_secs(2),
            ..Default::default()
        })
        .await
        .map_err(|e| anyhow!("instant display pipeline: {e:#}"))?;
    let mono = AudioInfo::new(Sample::F32(Type::Packed), 48_000, 1)?;
    let (mut atx, arx) = futures::channel::mpsc::channel::<AudioFrame>(64);
    let mic = OutputPipeline::builder(segment.join("audio-input.m4a"))
        .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(mono, arx))
        .with_timestamps(timestamps)
        .build::<FragmentedAudioMuxer>(FragmentedAudioMuxerConfig {
            shared_pause_state: None,
            write_behind: false,
        })
        .await
        .map_err(|e| anyhow!("mic pipeline: {e:#}"))?;
    let (mut iatx, iarx) = futures::channel::mpsc::channel::<AudioFrame>(64);
    let instant_audio = OutputPipeline::builder(instant.join("audio"))
        .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(mono, iarx))
        .with_timestamps(timestamps)
        .build::<DashSegmentedAudioMuxer>(DashSegmentedAudioMuxerConfig::default())
        .await
        .map_err(|e| anyhow!("instant audio pipeline: {e:#}"))?;
    let base = timestamps.instant();
    let frames = (SECONDS * f64::from(FPS)) as u32;
    for i in 0..frames {
        let at = base + Duration::from_secs_f64(0.05 + f64::from(i) / f64::from(FPS));
        tokio::time::sleep_until(at.into()).await;
        for tx in [&vtx, &ivtx] {
            let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, 320, 180);
            for (n, b) in frame.data_mut(0).iter_mut().enumerate() {
                *b = (n as u32 ^ i) as u8;
            }
            tx.send_async(FFmpegVideoFrame {
                inner: frame,
                timestamp: Timestamp::Instant(at),
            })
            .await
            .map_err(|_| anyhow!("video channel closed"))?;
        }
        use futures::SinkExt;
        for tx in [&mut atx, &mut iatx] {
            let samples: Vec<u8> = (0..1600)
                .flat_map(|n| ((f64::from(n) * 0.05).sin() as f32 * 0.3).to_ne_bytes())
                .collect();
            tx.send(AudioFrame::new(
                mono.wrap_frame(&samples),
                Timestamp::Instant(at),
            ))
            .await
            .map_err(|_| anyhow!("audio channel closed"))?;
        }
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    video
        .stop()
        .await
        .map_err(|e| anyhow!("display stop: {e:#}"))?;
    instant_video
        .stop()
        .await
        .map_err(|e| anyhow!("instant display stop: {e:#}"))?;
    mic.stop().await.map_err(|e| anyhow!("mic stop: {e:#}"))?;
    instant_audio
        .stop()
        .await
        .map_err(|e| anyhow!("instant audio stop: {e:#}"))?;
    drop((vtx, ivtx, atx, iatx));
    let meta = json!({
        "platform": "MacOS",
        "pretty_name": "chaos-fragments",
        "sharing": null,
        "segments": [{
            "display": { "path": "content/segments/segment-0/display.mp4", "fps": FPS, "start_time": 0.0 },
            "mic": { "path": "content/segments/segment-0/audio-input.m4a", "start_time": 0.0 }
        }],
        "status": { "status": "InProgress" }
    });
    std::fs::write(
        studio.join("recording-meta.json"),
        serde_json::to_vec_pretty(&meta)?,
    )?;
    Ok(())
}

fn fixture() -> anyhow::Result<std::path::PathBuf> {
    let key = cap_verify::fixture::cache_key(
        "chaos-fragments",
        &(SECONDS, FPS, cap_verify::pipeline::product_source_hash()),
    );
    cap_verify::fixture::ensure_fixture_keyed(key, |dir| {
        crate::common::runtime().block_on(record(dir))
    })
}

/// Makes sure the fixture exists before children race to create it.
pub fn prepare_fixture() -> anyhow::Result<()> {
    fixture().map(|_| ())
}

type Damage = Arc<dyn Fn(&Path) -> anyhow::Result<()> + Send + Sync>;

fn files_matching(dir: &Path, suffix: &str) -> Vec<std::path::PathBuf> {
    let mut out: Vec<_> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.ends_with(suffix))
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn on_each(
    dir: &'static str,
    suffix: &'static str,
    pick: fn(usize) -> Vec<usize>,
    act: fn(&Path) -> anyhow::Result<()>,
) -> Damage {
    Arc::new(move |root| {
        let files = files_matching(&root.join(dir), suffix);
        anyhow::ensure!(!files.is_empty(), "no {suffix} files in {dir}");
        for i in pick(files.len()) {
            if let Some(f) = files.get(i) {
                act(f)?;
            }
        }
        Ok(())
    })
}

fn zero(path: &Path) -> anyhow::Result<()> {
    Ok(std::fs::write(path, b"")?)
}

fn half(path: &Path) -> anyhow::Result<()> {
    let bytes = std::fs::read(path)?;
    Ok(std::fs::write(path, &bytes[..bytes.len() / 2])?)
}

fn head(path: &Path) -> anyhow::Result<()> {
    let bytes = std::fs::read(path)?;
    Ok(std::fs::write(path, &bytes[..bytes.len().min(13)])?)
}

fn garbage(path: &Path) -> anyhow::Result<()> {
    let bytes: Vec<u8> = (0..4000).map(|i| (i * 37 % 256) as u8).collect();
    Ok(std::fs::write(path, bytes)?)
}

fn smash(path: &Path) -> anyhow::Result<()> {
    let mut bytes = std::fs::read(path)?;
    let start = bytes.len() / 4;
    for (i, b) in bytes.iter_mut().skip(start).take(512).enumerate() {
        *b = (i as u8).wrapping_mul(13) ^ 0xa5;
    }
    Ok(std::fs::write(path, bytes)?)
}

fn remove(path: &Path) -> anyhow::Result<()> {
    Ok(std::fs::remove_file(path)?)
}

fn big_box(path: &Path) -> anyhow::Result<()> {
    let mut bytes = std::fs::read(path)?;
    if bytes.len() >= 8 {
        bytes[0..4].copy_from_slice(&u32::MAX.to_be_bytes());
    }
    Ok(std::fs::write(path, bytes)?)
}

fn zero_box(path: &Path) -> anyhow::Result<()> {
    let mut bytes = std::fs::read(path)?;
    if bytes.len() >= 8 {
        bytes[0..4].copy_from_slice(&0u32.to_be_bytes());
    }
    Ok(std::fs::write(path, bytes)?)
}

fn rename_tmp(path: &Path) -> anyhow::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    Ok(std::fs::rename(path, tmp)?)
}

fn damages(display: &'static str, audio: &'static str) -> Vec<(&'static str, Damage)> {
    let first = |_: usize| vec![0];
    let last = |n: usize| vec![n.saturating_sub(1)];
    let all = |n: usize| (0..n).collect();
    let middle = |n: usize| vec![n / 2];
    vec![
        ("control", Arc::new(|_: &Path| Ok(())) as Damage),
        ("init-missing", on_each(display, "init.mp4", first, remove)),
        ("init-zero", on_each(display, "init.mp4", first, zero)),
        ("init-truncated", on_each(display, "init.mp4", first, half)),
        ("init-garbage", on_each(display, "init.mp4", first, garbage)),
        (
            "init-box-size-huge",
            on_each(display, "init.mp4", first, big_box),
        ),
        (
            "init-box-size-zero",
            on_each(display, "init.mp4", first, zero_box),
        ),
        ("first-fragment-zero", on_each(display, ".m4s", first, zero)),
        (
            "last-fragment-truncated",
            on_each(display, ".m4s", last, half),
        ),
        (
            "middle-fragment-missing",
            on_each(display, ".m4s", middle, remove),
        ),
        (
            "middle-fragment-garbage",
            on_each(display, ".m4s", middle, garbage),
        ),
        (
            "middle-fragment-smashed",
            on_each(display, ".m4s", middle, smash),
        ),
        (
            "fragment-box-size-huge",
            on_each(display, ".m4s", middle, big_box),
        ),
        (
            "fragment-box-size-zero",
            on_each(display, ".m4s", middle, zero_box),
        ),
        ("fragment-header-only", on_each(display, ".m4s", all, head)),
        (
            "all-fragments-missing",
            on_each(display, ".m4s", all, remove),
        ),
        (
            "last-fragment-pending",
            on_each(display, ".m4s", last, rename_tmp),
        ),
        (
            "fragments-renumbered",
            Arc::new(move |root: &Path| {
                let files = files_matching(&root.join(display), ".m4s");
                for (i, f) in files.iter().enumerate().rev() {
                    let name = f.file_name().and_then(|n| n.to_str()).unwrap_or_default();
                    let renamed = name.replace(&format!("{i:03}"), &format!("{:03}", 999 - i));
                    std::fs::rename(f, f.with_file_name(renamed))?;
                }
                Ok(())
            }),
        ),
        (
            "manifest-garbage",
            Arc::new(move |root: &Path| {
                for f in files_matching(&root.join(display), ".json") {
                    std::fs::write(
                        f,
                        b"{\"segments\": [{\"index\": -1, \"duration\": \"x\"}, 7]",
                    )?;
                }
                Ok(())
            }),
        ),
        (
            "manifest-hostile-values",
            Arc::new(move |root: &Path| {
                for f in files_matching(&root.join(display), ".json") {
                    let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&f)?)
                        .unwrap_or(serde_json::Value::Null);
                    fn poison(v: &mut serde_json::Value) {
                        match v {
                            serde_json::Value::Number(_) => *v = json!(1e300),
                            serde_json::Value::Array(a) => a.iter_mut().for_each(poison),
                            serde_json::Value::Object(o) => o.values_mut().for_each(poison),
                            _ => {}
                        }
                    }
                    poison(&mut v);
                    std::fs::write(f, serde_json::to_vec(&v)?)?;
                }
                Ok(())
            }),
        ),
        (
            "audio-init-missing",
            on_each(audio, "init.mp4", first, remove),
        ),
        ("audio-fragments-zero", on_each(audio, ".m4s", all, zero)),
        (
            "audio-file-garbage",
            Arc::new(move |root: &Path| {
                let path = root.join(audio);
                if path.is_file() {
                    garbage(&path)
                } else {
                    for f in files_matching(&path, ".m4s") {
                        garbage(&f)?;
                    }
                    Ok(())
                }
            }),
        ),
        (
            "audio-missing",
            Arc::new(move |root: &Path| {
                let path = root.join(audio);
                if path.is_dir() {
                    std::fs::remove_dir_all(&path)?;
                } else {
                    std::fs::remove_file(&path)?;
                }
                Ok(())
            }),
        ),
    ]
}

fn judge_mp4(path: &Path) -> Verdict {
    super::media_check::judge_output(path, true)
}

fn recover(dir: &Path) -> anyhow::Result<Verdict> {
    let Some(incomplete) = RecoveryManager::inspect_recording(dir) else {
        return Ok(Verdict::rejected("nothing recoverable"));
    };
    match RecoveryManager::recover(&incomplete) {
        Err(e) => Ok(Verdict::rejected(format!("recover: {e}"))),
        Ok(_) => {
            let meta = match cap_project::RecordingMeta::load_for_project(dir) {
                Ok(meta) => meta,
                Err(e) => {
                    return Ok(Verdict::Wrong(format!(
                        "recovered but the meta is unreadable: {e}"
                    )));
                }
            };
            let display = match meta.studio_meta() {
                Some(cap_project::StudioRecordingMeta::MultipleSegments { inner }) => {
                    inner.segments.first().map(|s| s.display.path.to_path(dir))
                }
                Some(cap_project::StudioRecordingMeta::SingleSegment { segment }) => {
                    Some(segment.display.path.to_path(dir))
                }
                None => None,
            };
            Ok(match display {
                Some(path) => judge_mp4(&path),
                None => Verdict::Wrong("recovered with no display track".into()),
            })
        }
    }
}

fn probes_for(out: &mut Vec<Probe>) {
    let studio_display = "studio/content/segments/segment-0/display";
    let studio_audio = "studio/content/segments/segment-0/audio-input.m4a";
    for (name, damage) in damages(studio_display, studio_audio) {
        // The Studio microphone track is one fragmented file, not a
        // directory of fragments.
        if matches!(name, "audio-init-missing" | "audio-fragments-zero") {
            continue;
        }
        let d = damage.clone();
        out.push(Probe::new(
            format!("chaos/fragments/recover/{name}"),
            90,
            move |ctx: &Ctx| {
                let root = ctx.path("fx");
                copy_dir(&fixture()?, &root)?;
                d(&root).context("damage")?;
                recover(&root.join("studio"))
            },
        ));
        if name.starts_with("audio") {
            continue;
        }
        out.push(Probe::new(
            format!("chaos/fragments/finalize-display/{name}"),
            60,
            move |ctx: &Ctx| {
                let root = ctx.path("fx");
                copy_dir(&fixture()?, &root)?;
                damage(&root).context("damage")?;
                let out = ctx.path("display.mp4");
                match RecoveryManager::finalize_to_progressive_mp4(&root.join(studio_display), &out)
                {
                    Err(e) => Ok(Verdict::rejected(format!("finalize: {e}"))),
                    Ok(_) => Ok(judge_mp4(&out)),
                }
            },
        ));
    }
    for (name, damage) in damages("instant/content/display", "instant/content/audio") {
        out.push(Probe::new(
            format!("chaos/fragments/instant-finalize/{name}"),
            60,
            move |ctx: &Ctx| {
                let root = ctx.path("fx");
                copy_dir(&fixture()?, &root)?;
                damage(&root).context("damage")?;
                let content = root.join("instant/content");
                let out = content.join("output.mp4");
                match RecoveryManager::finalize_instant_output(
                    &content.join("display"),
                    &content.join("audio"),
                    &out,
                ) {
                    Err(e) => Ok(Verdict::rejected(format!("finalize: {e}"))),
                    Ok(_) => Ok(judge_mp4(&out)),
                }
            },
        ));
    }
}

pub fn probes() -> Vec<Probe> {
    let mut out = Vec::new();
    probes_for(&mut out);
    out
}

/// Byte-level fuzzing of every fragment file, then recovery and Instant
/// finalization.
pub fn fuzz_probes() -> Vec<Probe> {
    fn mutate_tree(ctx: &Ctx, dir: &Path, salt: u64) -> anyhow::Result<usize> {
        let mut files = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for entry in std::fs::read_dir(&d)? {
                let path = entry?.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| matches!(e, "mp4" | "m4s" | "m4a"))
                {
                    files.push(path);
                }
            }
        }
        files.sort();
        anyhow::ensure!(!files.is_empty(), "no fragments under {}", dir.display());
        let mut rng = cap_verify::fixture::Rng::new(ctx.seed ^ salt);
        let mutations = super::fuzz::byte_mutations(ctx.seed, salt);
        for (i, m) in mutations.iter().enumerate() {
            let file = &files[rng.range(0, files.len() as u64 - 1) as usize];
            if ctx.keeps(i) {
                let mut bytes = std::fs::read(file)?;
                m.apply(&mut bytes);
                std::fs::write(file, bytes)?;
            }
        }
        Ok(mutations.len())
    }
    fn tagged(v: Verdict, n: usize) -> Verdict {
        match v {
            Verdict::Ok(t) => Verdict::Ok(format!("mutations={n}; {t}")),
            Verdict::Rejected(t) => Verdict::Rejected(format!("mutations={n}; {t}")),
            Verdict::Wrong(t) => Verdict::Wrong(format!("mutations={n}; {t}")),
        }
    }
    vec![
        Probe::new("chaos/fuzz/fragments/recover", 90, |ctx: &Ctx| {
            let root = ctx.path("fx");
            copy_dir(&fixture()?, &root)?;
            let studio = root.join("studio");
            let n = mutate_tree(ctx, &studio.join("content"), 11)?;
            Ok(tagged(recover(&studio)?, n))
        })
        .seeded(10, 120),
        Probe::new("chaos/fuzz/fragments/instant-finalize", 60, |ctx: &Ctx| {
            let root = ctx.path("fx");
            copy_dir(&fixture()?, &root)?;
            let content = root.join("instant/content");
            let n = mutate_tree(ctx, &content, 12)?;
            let out = content.join("output.mp4");
            let v = match RecoveryManager::finalize_instant_output(
                &content.join("display"),
                &content.join("audio"),
                &out,
            ) {
                Err(e) => Verdict::rejected(format!("finalize: {e}")),
                Ok(_) => super::media_check::judge_output(&out, false),
            };
            Ok(tagged(v, n))
        })
        .seeded(10, 120),
    ]
}
