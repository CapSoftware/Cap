use super::*;
use cap_enc_ffmpeg::{
    dash_audio::{DashAudioSegmentEncoder, DashAudioSegmentEncoderConfig},
    segmented_stream::{SegmentedVideoEncoder, SegmentedVideoEncoderConfig},
};
use cap_media_info::{AudioInfo, VideoInfo};
use std::time::{Duration, Instant};

fn env_list(name: &str, default: &str) -> Vec<u64> {
    std::env::var(name)
        .unwrap_or_else(|_| default.into())
        .split(',')
        .filter_map(|value| value.trim().parse().ok())
        .collect()
}

fn write_video(content: &Path, seconds: u64, width: u32, height: u32) {
    let info = VideoInfo {
        pixel_format: cap_media_info::Pixel::NV12,
        width,
        height,
        time_base: ffmpeg::Rational(1, 1_000_000),
        frame_rate: ffmpeg::Rational(30, 1),
    };
    let mut encoder = SegmentedVideoEncoder::init(
        content.join("display"),
        info,
        SegmentedVideoEncoderConfig::default(),
    )
    .unwrap();
    let block = 96usize;
    for index in 0..seconds * 30 {
        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, width, height);
        let stride = frame.stride(0);
        let luma = frame.data_mut(0);
        for (row, line) in luma.chunks_mut(stride).enumerate() {
            for (column, byte) in line.iter_mut().enumerate() {
                *byte = ((row / 8 + column / 8) % 200) as u8 + 30;
            }
        }
        let x0 = (index as usize * 7) % (width as usize - block);
        let y0 = (index as usize * 3) % (height as usize - block);
        let mut seed = index as u32 ^ 0x9E37_79B9;
        for row in y0..y0 + block {
            for column in x0..x0 + block {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                luma[row * stride + column] = (seed & 0xff) as u8;
            }
        }
        let chroma = frame.data_mut(1);
        chroma.fill(128);
        encoder
            .queue_frame(frame, Duration::from_micros(index * 1_000_000 / 30))
            .unwrap();
    }
    encoder.finish().unwrap();
}

fn write_audio(content: &Path, seconds: u64) {
    let info = AudioInfo {
        sample_format: ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
        sample_rate: 48_000,
        channels: 1,
        time_base: ffmpeg::Rational(1, 48_000),
        buffer_size: 1024,
        is_wireless_transport: false,
    };
    let mut encoder = DashAudioSegmentEncoder::init(
        content.join("audio"),
        info,
        DashAudioSegmentEncoderConfig::default(),
    )
    .unwrap();
    let mut offset = 0u64;
    while offset < seconds * 48_000 {
        let mut frame = ffmpeg::frame::Audio::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
            1024,
            ffmpeg::ChannelLayout::MONO,
        );
        frame.set_rate(48_000);
        frame.set_pts(Some(offset as i64));
        for (i, chunk) in frame.data_mut(0).chunks_exact_mut(4).enumerate() {
            let t = (offset as f32 + i as f32) / 48_000.0;
            chunk.copy_from_slice(&((t * 440.0 * std::f32::consts::TAU).sin() * 0.3).to_ne_bytes());
        }
        encoder
            .queue_frame(frame, Duration::from_micros(offset * 1_000_000 / 48_000))
            .unwrap();
        offset += 1024;
    }
    encoder.finish().unwrap();
}

fn copy_tree(source: &Path, destination: &Path) {
    std::fs::create_dir_all(destination).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let target = destination.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn tree_size(path: &Path) -> u64 {
    std::fs::read_dir(path)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                tree_size(&entry.path())
            } else {
                entry.metadata().unwrap().len()
            }
        })
        .sum()
}

fn ensure_fixture(root: &Path, seconds: u64) -> PathBuf {
    let fixture = root.join(format!("fixture-{seconds}"));
    if !fixture.join("content/audio/manifest.json").exists() {
        let started = Instant::now();
        let content = fixture.join("content");
        std::fs::create_dir_all(&content).unwrap();
        write_video(&content, seconds, 1920, 1080);
        write_audio(&content, seconds);
        eprintln!("fixture {seconds}s written in {:?}", started.elapsed());
    }
    fixture
}

#[test]
#[ignore = "manual Instant finalize benchmark"]
fn instant_finalize_benchmark() {
    ffmpeg::init().unwrap();
    if std::env::var_os("CAP_FINALIZE_BENCH_LOG").is_some() {
        let _ = tracing_subscriber::fmt()
            .with_timer(tracing_subscriber::fmt::time::uptime())
            .with_env_filter("cap_recording=debug,cap_enc_ffmpeg=info")
            .with_writer(std::io::stderr)
            .try_init();
    }
    let root = std::env::var_os("CAP_FINALIZE_BENCH_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("cap-instant-finalize-bench"));
    let runs = env_list("CAP_FINALIZE_BENCH_RUNS", "3")[0];
    for seconds in env_list("CAP_FINALIZE_BENCH_SECONDS", "60,300,1800") {
        let fixture = ensure_fixture(&root, seconds);
        let bytes = tree_size(&fixture.join("content"));
        for run in 0..runs {
            let project = root.join(format!("run-{seconds}-{run}.cap"));
            let _ = std::fs::remove_dir_all(&project);
            copy_tree(&fixture, &project);
            let content = project.join("content");

            let staged = project.join(".bench-staging");
            let started = Instant::now();
            copy_recovery_input_with_durability(
                &content,
                &staged,
                RecoveryCopyDurability::Deferred,
            )
            .unwrap();
            let copy = started.elapsed();
            std::fs::remove_dir_all(&staged).unwrap();

            let started = Instant::now();
            RecoveryManager::finalize_instant_output_with_completion(
                &content.join("display"),
                &content.join("audio"),
                &content.join("output.mp4"),
                Some((project.clone(), true)),
            )
            .unwrap();
            let total = started.elapsed();
            let output = std::fs::metadata(content.join("output.mp4")).unwrap().len();
            eprintln!(
                "instant-finalize {seconds}s run {run}: input {:.1} MB, output {:.1} MB, staging copy {:.3}s, finalize total {:.3}s",
                bytes as f64 / 1e6,
                output as f64 / 1e6,
                copy.as_secs_f64(),
                total.as_secs_f64(),
            );
            std::fs::remove_dir_all(&project).unwrap();
        }
    }
}

fn timed<T>(label: &str, step: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let value = step();
    eprintln!("  phase {label}: {:.3}s", started.elapsed().as_secs_f64());
    value
}

#[test]
#[ignore = "manual Instant finalize phase benchmark"]
fn instant_finalize_phases() {
    ffmpeg::init().unwrap();
    let root = std::env::var_os("CAP_FINALIZE_BENCH_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("cap-instant-finalize-bench"));
    for seconds in env_list("CAP_FINALIZE_BENCH_SECONDS", "1800") {
        let fixture = ensure_fixture(&root, seconds);
        let work = root.join(format!("phases-{seconds}"));
        let _ = std::fs::remove_dir_all(&work);
        copy_tree(&fixture.join("content"), &work);
        eprintln!("instant-finalize phases {seconds}s:");
        let project = root.join(format!("snapshot-{seconds}.cap"));
        let _ = std::fs::remove_dir_all(&project);
        copy_tree(&fixture, &project);
        timed("recovery snapshot", || recovery_snapshot(&project).unwrap());
        timed("recovery snapshot again", || {
            recovery_snapshot(&project).unwrap()
        });
        timed("manifest validation", || {
            validate_recovery_manifests(&project.join("content")).unwrap()
        });
        let staged = project.join(".staged");
        timed("staging copy (deferred)", || {
            copy_recovery_input_with_durability(
                &project.join("content"),
                &staged,
                RecoveryCopyDurability::Deferred,
            )
            .unwrap()
        });
        std::fs::remove_dir_all(&project).unwrap();
        let video = RecoveryManager::find_complete_fragments_with_init(&work.join("display"));
        let audio = RecoveryManager::find_complete_fragments_with_init(&work.join("audio"));
        let video_out = work.join("v.mp4");
        let audio_out = work.join("a.mp4");
        let merged = work.join("m.mp4");
        timed("video concat (validated)", || {
            cap_enc_ffmpeg::remux::concatenate_m4s_segments_with_init_validated(
                video.init_segment.as_deref().unwrap(),
                &video.fragments,
                &video_out,
            )
            .unwrap()
        });
        timed("video check (bounded)", || {
            RecoveryManager::check_required_video(&video_out, "display", VideoValidation::Bounded)
                .unwrap()
                .unwrap()
        });
        let input_digest = timed("audio input decode (full, with digest)", || {
            validate_audio_inputs_with_digest(
                &audio.fragments,
                audio.init_segment.as_deref(),
                &work,
            )
            .unwrap()
        });
        timed("audio concat", || {
            cap_enc_ffmpeg::remux::concatenate_m4s_segments_with_init(
                audio.init_segment.as_deref().unwrap(),
                &audio.fragments,
                &audio_out,
            )
            .unwrap()
        });
        timed("merge", || {
            merge_video_audio(&video_out, &audio_out, &merged).unwrap()
        });
        timed("merged video check (bounded)", || {
            RecoveryManager::check_required_video(&merged, "display", VideoValidation::Bounded)
                .unwrap()
                .unwrap()
        });
        timed("merged audio decode", || {
            validate_recovered_track(&merged, ffmpeg::media::Type::Audio).unwrap()
        });
        let merged_digest = timed("merged audio digest", || {
            audio_packet_digest(&merged).unwrap()
        });
        eprintln!(
            "  merged audio matches inputs: {}",
            Some(merged_digest) == input_digest
        );
        timed("fsync output", || sync_recovery_input(&merged).unwrap());
        std::fs::remove_dir_all(&work).unwrap();
    }
}
