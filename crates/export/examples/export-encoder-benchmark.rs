use cap_editor::{AudioRenderer, AudioSegment, create_segments, get_audio_segments};
use cap_enc_ffmpeg::{AudioEncoder, aac::AACEncoder, h264::H264Encoder, mp4::MP4File};
use cap_export::mp4::ExportCompression;
use cap_media_info::{RawVideoFormat, VideoInfo};
use cap_project::{ProjectConfiguration, RecordingMeta};
use clap::Parser;
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Parser, Debug)]
struct Cli {
    #[arg(long, default_value_t = 3)]
    duration: u32,
    #[arg(long, default_value_t = 4)]
    pattern_frames: usize,
    #[arg(long)]
    output_dir: Option<PathBuf>,
    #[arg(long)]
    recording_path: Option<PathBuf>,
    #[arg(long, default_value_t = false)]
    force_ffmpeg_decoder: bool,
}

#[derive(Clone, Copy)]
struct Preset {
    label: &'static str,
    width: u32,
    height: u32,
    fps: u32,
    compression: ExportCompression,
}

#[derive(Serialize)]
struct BenchmarkResult {
    label: String,
    width: u32,
    height: u32,
    fps: u32,
    compression: String,
    frames: u32,
    encode_loop_ms: u128,
    finish_ms: u128,
    total_ms: u128,
    effective_fps: f64,
    output_mb: f64,
    has_audio: bool,
    audio_frames: u32,
    audio_samples: u64,
    audio_render_us: u128,
}

struct AudioFixture {
    project_config: ProjectConfiguration,
    audio_segments: Vec<AudioSegment>,
}

fn presets() -> Vec<Preset> {
    vec![
        Preset {
            label: "MP4 1080p/30fps/Maximum",
            width: 1920,
            height: 1080,
            fps: 30,
            compression: ExportCompression::Maximum,
        },
        Preset {
            label: "MP4 1080p/30fps/Social",
            width: 1920,
            height: 1080,
            fps: 30,
            compression: ExportCompression::Social,
        },
        Preset {
            label: "MP4 1080p/60fps/Maximum",
            width: 1920,
            height: 1080,
            fps: 60,
            compression: ExportCompression::Maximum,
        },
        Preset {
            label: "MP4 4K/30fps/Maximum",
            width: 3840,
            height: 2160,
            fps: 30,
            compression: ExportCompression::Maximum,
        },
        Preset {
            label: "MP4 4K/30fps/Social",
            width: 3840,
            height: 2160,
            fps: 30,
            compression: ExportCompression::Social,
        },
    ]
}

fn compression_label(compression: ExportCompression) -> &'static str {
    match compression {
        ExportCompression::Maximum => "Maximum",
        ExportCompression::Social => "Social",
        ExportCompression::Web => "Web",
        ExportCompression::Potato => "Potato",
    }
}

fn make_nv12_pattern(width: u32, height: u32, frame_index: usize) -> Vec<u8> {
    let width = width as usize;
    let height = height as usize;
    let y_size = width * height;
    let uv_size = width * height / 2;
    let mut data = vec![0u8; y_size + uv_size];

    for row in 0..height {
        let row_start = row * width;
        for col in 0..width {
            data[row_start + col] = ((row * 3 + col * 5 + frame_index * 11) % 220 + 16) as u8;
        }
    }

    for row in 0..height / 2 {
        let row_start = y_size + row * width;
        for col in (0..width).step_by(2) {
            data[row_start + col] = ((row * 7 + col * 3 + frame_index * 13) % 128 + 64) as u8;
            data[row_start + col + 1] = ((row * 5 + col * 11 + frame_index * 17) % 128 + 64) as u8;
        }
    }

    data
}

fn copy_nv12_to_frame(frame: &mut ffmpeg::frame::Video, nv12_data: &[u8], width: u32, height: u32) {
    let width = width as usize;
    let height = height as usize;
    let y_size = width * height;
    let y_src = &nv12_data[..y_size];
    let uv_src = &nv12_data[y_size..];

    let y_stride = frame.stride(0);
    {
        let y_dst = frame.data_mut(0);
        if y_stride == width {
            y_dst[..y_size].copy_from_slice(y_src);
        } else {
            for row in 0..height {
                let src_start = row * width;
                let dst_start = row * y_stride;
                y_dst[dst_start..dst_start + width]
                    .copy_from_slice(&y_src[src_start..src_start + width]);
            }
        }
    }

    let uv_stride = frame.stride(1);
    let uv_height = height / 2;
    {
        let uv_dst = frame.data_mut(1);
        if uv_stride == width {
            uv_dst[..uv_src.len()].copy_from_slice(uv_src);
        } else {
            for row in 0..uv_height {
                let src_start = row * width;
                let dst_start = row * uv_stride;
                uv_dst[dst_start..dst_start + width]
                    .copy_from_slice(&uv_src[src_start..src_start + width]);
            }
        }
    }
}

fn run_preset(
    preset: Preset,
    duration: u32,
    pattern_frames: usize,
    output_dir: &Path,
    audio_fixture: Option<&AudioFixture>,
) -> Result<BenchmarkResult, String> {
    let frames = duration * preset.fps;
    let mut video_info = VideoInfo::from_raw(
        RawVideoFormat::Nv12,
        preset.width,
        preset.height,
        preset.fps,
    );
    video_info.time_base = ffmpeg::Rational::new(1, preset.fps as i32);
    let output_path = output_dir.join(
        preset
            .label
            .replace('/', "-")
            .replace(' ', "_")
            .to_lowercase(),
    );
    let output_file = output_path.with_extension("mp4");

    let patterns = (0..pattern_frames.max(1))
        .map(|i| make_nv12_pattern(preset.width, preset.height, i))
        .collect::<Vec<_>>();
    let has_audio = audio_fixture
        .filter(|fixture| !fixture.project_config.audio.mute)
        .is_some_and(|fixture| {
            fixture
                .audio_segments
                .first()
                .is_some_and(|segment| !segment.tracks.is_empty())
        });

    let mut encoder = MP4File::init(
        "encoder-benchmark",
        output_path,
        false,
        |o| {
            H264Encoder::builder(video_info)
                .with_bpp(preset.compression.bits_per_pixel())
                .with_export_priority()
                .with_export_settings()
                .with_external_conversion()
                .build(o)
        },
        |o| {
            has_audio.then(|| {
                AACEncoder::init(AudioRenderer::info(), o)
                    .map(|v| v.boxed())
                    .map_err(Into::into)
            })
        },
    )
    .map_err(|err| err.to_string())?;

    let audio_project_config = audio_fixture.map(|fixture| fixture.project_config.clone());
    let mut audio_renderer = if has_audio {
        audio_fixture.map(|fixture| {
            let mut renderer = AudioRenderer::new_with_project(
                fixture.audio_segments.clone(),
                &fixture.project_config,
            );
            renderer.set_playhead(0.0, &fixture.project_config);
            renderer
        })
    } else {
        None
    };
    let mut audio_sample_cursor = 0u64;
    let mut audio_frames = 0u32;
    let mut audio_samples = 0u64;
    let mut audio_render_elapsed = Duration::ZERO;
    let sample_rate = u64::from(AudioRenderer::SAMPLE_RATE);
    let fps_u64 = u64::from(preset.fps);

    let mut frame =
        ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, preset.width, preset.height);
    let mut converted_frame = None;
    let encode_start = Instant::now();

    for frame_number in 0..frames {
        let pattern = &patterns[frame_number as usize % patterns.len()];
        copy_nv12_to_frame(&mut frame, pattern, preset.width, preset.height);
        frame.set_pts(Some(frame_number as i64));
        encoder
            .queue_video_frame_reusable(&mut frame, &mut converted_frame, Duration::MAX)
            .map_err(|err| err.to_string())?;

        if let (Some(audio), Some(project_config)) =
            (&mut audio_renderer, audio_project_config.as_ref())
        {
            let frame_number = u64::from(frame_number);
            let end = ((frame_number + 1) * sample_rate) / fps_u64;
            if end > audio_sample_cursor {
                let pts = audio_sample_cursor as i64;
                let samples = (end - audio_sample_cursor) as usize;
                audio_sample_cursor = end;
                let audio_started = Instant::now();
                let audio_frame = audio
                    .render_frame(samples, project_config)
                    .map(|mut frame| {
                        frame.set_pts(Some(pts));
                        frame
                    });
                audio_render_elapsed += audio_started.elapsed();
                if let Some(audio_frame) = audio_frame {
                    encoder.queue_audio_frame(audio_frame);
                    audio_frames += 1;
                    audio_samples += samples as u64;
                }
            }
        }
    }

    let encode_loop_elapsed = encode_start.elapsed();
    let finish_start = Instant::now();
    let finish = encoder.finish().map_err(|err| err.to_string())?;
    finish
        .video_finish
        .map_err(|err| format!("Video encoding failed: {err}"))?;
    finish
        .audio_finish
        .map_err(|err| format!("Audio encoding failed: {err}"))?;
    let finish_elapsed = finish_start.elapsed();
    let total_elapsed = encode_start.elapsed();
    let output_mb = std::fs::metadata(output_file)
        .map(|m| m.len() as f64 / 1024.0 / 1024.0)
        .unwrap_or(0.0);

    Ok(BenchmarkResult {
        label: preset.label.to_string(),
        width: preset.width,
        height: preset.height,
        fps: preset.fps,
        compression: compression_label(preset.compression).to_string(),
        frames,
        encode_loop_ms: encode_loop_elapsed.as_millis(),
        finish_ms: finish_elapsed.as_millis(),
        total_ms: total_elapsed.as_millis(),
        effective_fps: frames as f64 / total_elapsed.as_secs_f64().max(0.001),
        output_mb,
        has_audio,
        audio_frames,
        audio_samples,
        audio_render_us: audio_render_elapsed.as_micros(),
    })
}

async fn load_audio_fixture(
    path: &Path,
    force_ffmpeg_decoder: bool,
) -> Result<AudioFixture, String> {
    let recording_meta = RecordingMeta::load_for_project(path).map_err(|err| err.to_string())?;
    let studio_meta = recording_meta
        .studio_meta()
        .ok_or_else(|| "recording is not a studio recording".to_string())?
        .clone();
    let project_config = recording_meta.project_config();
    let segments = create_segments(&recording_meta, &studio_meta, force_ffmpeg_decoder)
        .await
        .map_err(|err| err.to_string())?;
    let audio_segments = get_audio_segments(&segments);

    Ok(AudioFixture {
        project_config,
        audio_segments,
    })
}

#[tokio::main]
async fn main() -> Result<(), String> {
    ffmpeg::init().map_err(|err| err.to_string())?;
    let cli = Cli::parse();
    let temp_dir = tempfile::TempDir::new().map_err(|err| err.to_string())?;
    let output_dir = cli.output_dir.as_deref().unwrap_or(temp_dir.path());
    std::fs::create_dir_all(output_dir).map_err(|err| err.to_string())?;
    let audio_fixture = if let Some(recording_path) = cli.recording_path.as_deref() {
        Some(load_audio_fixture(recording_path, cli.force_ffmpeg_decoder).await?)
    } else {
        None
    };

    let mut results = Vec::new();
    for preset in presets() {
        let result = run_preset(
            preset,
            cli.duration,
            cli.pattern_frames,
            output_dir,
            audio_fixture.as_ref(),
        )?;
        eprintln!(
            "{}: {:.1} fps, {:.2} MB",
            result.label, result.effective_fps, result.output_mb
        );
        results.push(result);
    }

    println!(
        "{}",
        serde_json::to_string_pretty(&results).map_err(|err| err.to_string())?
    );

    Ok(())
}
