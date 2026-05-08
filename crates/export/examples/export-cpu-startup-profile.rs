use cap_audio::{AudioData, AudioRendererTrack, StereoMode, linear_gain_for_db, render_audio};
use cap_editor::{AudioSegment, create_segments, get_audio_segments};
use cap_project::RecordingMeta;
use cap_rendering::{
    PrecomputedCursorTimeline, ProjectRecordingsMeta, ZoomFocusInterpolator, get_duration,
    spring_mass_damper::SpringMassDamperSimulationConfig,
};
use clap::Parser;
use serde::Serialize;
use std::{hint::black_box, path::PathBuf, sync::Arc, time::Instant};

#[derive(Parser, Debug)]
struct Cli {
    path: PathBuf,
    #[arg(long, default_value_t = 60)]
    fps: u32,
    #[arg(long, default_value_t = false)]
    force_ffmpeg_decoder: bool,
}

#[derive(Serialize)]
struct ExportCpuStartupProfile {
    project: String,
    fps: u32,
    duration_secs: f64,
    total_frames: u32,
    recording_meta_load_ms: u128,
    project_config_load_ms: u128,
    recordings_meta_load_ms: u128,
    segment_media_load_ms: u128,
    precomputed_cursor_timelines_ms: u128,
    zoom_interpolator_construct_ms: u128,
    zoom_full_precompute_ms: u128,
    zoom_lazy_first_frame_ms: u128,
    zoom_lazy_all_frames_ms: u128,
    audio_mix_profile: Option<AudioMixProfile>,
}

#[derive(Serialize)]
struct AudioMixProfile {
    tracks: usize,
    frame_samples: usize,
    iterations: usize,
    baseline_ms: u128,
    optimized_ms: u128,
    speedup: f64,
    outputs_equal: bool,
}

struct BaselineAudioRendererTrack<'a> {
    data: &'a AudioData,
    gain_db: f32,
    stereo_mode: StereoMode,
    offset: isize,
}

fn elapsed_ms(start: Instant) -> u128 {
    start.elapsed().as_millis()
}

fn cursor_smoothing(
    project_config: &cap_project::ProjectConfiguration,
) -> Option<SpringMassDamperSimulationConfig> {
    (!project_config.cursor.raw).then_some(SpringMassDamperSimulationConfig {
        tension: project_config.cursor.tension,
        mass: project_config.cursor.mass,
        friction: project_config.cursor.friction,
    })
}

fn build_zoom_interpolators(
    segments: &[cap_editor::SegmentMedia],
    cursor_timelines: &[Arc<PrecomputedCursorTimeline>],
    project_config: &cap_project::ProjectConfiguration,
    duration_secs: f64,
) -> Vec<ZoomFocusInterpolator> {
    let smoothing = cursor_smoothing(project_config);
    let click_spring = project_config.cursor.click_spring_config();
    let zoom_segments = project_config
        .timeline
        .as_ref()
        .map(|timeline| timeline.zoom_segments.as_slice())
        .unwrap_or(&[]);

    segments
        .iter()
        .zip(cursor_timelines.iter())
        .map(|(segment, precomputed_cursor)| {
            ZoomFocusInterpolator::new_with_precomputed_cursor(
                &segment.cursor,
                smoothing,
                click_spring,
                project_config.screen_movement_spring,
                duration_secs,
                zoom_segments,
                Some(precomputed_cursor.clone()),
            )
        })
        .collect()
}

fn render_audio_baseline(
    tracks: &[BaselineAudioRendererTrack],
    offset: usize,
    samples: usize,
    out_offset: usize,
    out: &mut [f32],
) -> usize {
    let samples = samples.min(
        tracks
            .iter()
            .filter_map(|t| {
                let track_samples = t.data.samples().len() / t.data.channels() as usize;
                let available = track_samples as isize - offset as isize - t.offset;
                if available > 0 {
                    Some(available as usize)
                } else {
                    None
                }
            })
            .max()
            .unwrap_or(0),
    );

    for i in 0..samples {
        let mut left: f32 = 0.0;
        let mut right: f32 = 0.0;

        for track in tracks {
            let i = i.wrapping_add_signed(track.offset);

            let data = track.data;
            let gain = linear_gain_for_db(track.gain_db);

            if gain == 0.0 {
                continue;
            }

            if data.channels() == 1 {
                if let Some(sample) = data.samples().get(offset + i) {
                    left += sample * 0.707 * gain;
                    right += sample * 0.707 * gain;
                }
            } else if data.channels() == 2 {
                let base_idx = offset * 2 + i * 2;
                let Some(l_sample) = data.samples().get(base_idx) else {
                    continue;
                };
                let Some(r_sample) = data.samples().get(base_idx + 1) else {
                    continue;
                };

                match track.stereo_mode {
                    StereoMode::Stereo => {
                        left += l_sample * gain;
                        right += r_sample * gain;
                    }
                    StereoMode::MonoL => {
                        left += l_sample * gain;
                        right += l_sample * gain;
                    }
                    StereoMode::MonoR => {
                        left += r_sample * gain;
                        right += r_sample * gain;
                    }
                }
            }
        }

        let l = left.clamp(-1.0, 1.0);
        let r = right.clamp(-1.0, 1.0);
        out[out_offset + i * 2] = l;
        out[out_offset + i * 2 + 1] = r;
    }

    samples
}

fn benchmark_audio_mix(
    audio_segments: &[AudioSegment],
    project_config: &cap_project::ProjectConfiguration,
) -> Option<AudioMixProfile> {
    let (clip_index, segment) = audio_segments
        .iter()
        .enumerate()
        .find(|(_, segment)| !segment.tracks.is_empty())?;

    let offsets = project_config
        .clips
        .iter()
        .find(|clip| clip.index == clip_index as u32)
        .map(|clip| clip.offsets)
        .unwrap_or_default();

    let baseline_tracks = segment
        .tracks
        .iter()
        .map(|track| {
            let gain_db = if project_config.audio.mute {
                -30.0
            } else {
                track.gain(&project_config.audio)
            };
            BaselineAudioRendererTrack {
                data: track.data().as_ref(),
                gain_db,
                stereo_mode: track.stereo_mode(&project_config.audio),
                offset: (track.offset(&offsets) * AudioData::SAMPLE_RATE as f32) as isize,
            }
        })
        .collect::<Vec<_>>();

    let tracks = segment
        .tracks
        .iter()
        .map(|track| AudioRendererTrack {
            data: track.data().as_ref(),
            linear_gain: if project_config.audio.mute {
                0.0
            } else {
                linear_gain_for_db(track.gain(&project_config.audio))
            },
            stereo_mode: track.stereo_mode(&project_config.audio),
            offset: (track.offset(&offsets) * AudioData::SAMPLE_RATE as f32) as isize,
        })
        .collect::<Vec<_>>();

    if tracks.is_empty() {
        return None;
    }

    let frame_samples = 1600usize;
    let iterations = 1000usize;
    let mut baseline_out = vec![0.0; frame_samples * 2];
    let mut optimized_out = vec![0.0; frame_samples * 2];

    let started = Instant::now();
    for _ in 0..iterations {
        render_audio_baseline(
            &baseline_tracks,
            0,
            frame_samples,
            0,
            black_box(&mut baseline_out),
        );
    }
    let baseline_elapsed = started.elapsed();

    let started = Instant::now();
    for _ in 0..iterations {
        render_audio(&tracks, 0, frame_samples, 0, black_box(&mut optimized_out));
    }
    let optimized_elapsed = started.elapsed();

    Some(AudioMixProfile {
        tracks: tracks.len(),
        frame_samples,
        iterations,
        baseline_ms: baseline_elapsed.as_millis(),
        optimized_ms: optimized_elapsed.as_millis(),
        speedup: baseline_elapsed.as_secs_f64() / optimized_elapsed.as_secs_f64(),
        outputs_equal: baseline_out == optimized_out,
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    let started = Instant::now();
    let recording_meta = RecordingMeta::load_for_project(&cli.path)?;
    let recording_meta_load_ms = elapsed_ms(started);

    let studio_meta = recording_meta
        .studio_meta()
        .ok_or_else(|| std::io::Error::other("recording is not a studio recording"))?
        .clone();

    let started = Instant::now();
    let project_config = recording_meta.project_config();
    let project_config_load_ms = elapsed_ms(started);

    let started = Instant::now();
    let recordings = Arc::new(
        ProjectRecordingsMeta::new(&recording_meta.project_path, &studio_meta)
            .map_err(std::io::Error::other)?,
    );
    let recordings_meta_load_ms = elapsed_ms(started);

    let duration_secs = get_duration(&recordings, &recording_meta, &studio_meta, &project_config);
    let total_frames = (duration_secs * f64::from(cli.fps)).ceil() as u32;

    let started = Instant::now();
    let segments = create_segments(&recording_meta, &studio_meta, cli.force_ffmpeg_decoder)
        .await
        .map_err(std::io::Error::other)?;
    let segment_media_load_ms = elapsed_ms(started);
    let audio_segments = get_audio_segments(&segments);
    let audio_mix_profile = benchmark_audio_mix(&audio_segments, &project_config);

    let smoothing = cursor_smoothing(&project_config);
    let click_spring = project_config.cursor.click_spring_config();

    let started = Instant::now();
    let cursor_timelines: Vec<Arc<PrecomputedCursorTimeline>> = segments
        .iter()
        .map(|segment| {
            Arc::new(PrecomputedCursorTimeline::new(
                &segment.cursor,
                smoothing,
                Some(click_spring),
            ))
        })
        .collect();
    let precomputed_cursor_timelines_ms = elapsed_ms(started);

    let started = Instant::now();
    let mut full_zoom =
        build_zoom_interpolators(&segments, &cursor_timelines, &project_config, duration_secs);
    let zoom_interpolator_construct_ms = elapsed_ms(started);

    let started = Instant::now();
    for interpolator in &mut full_zoom {
        interpolator.ensure_precomputed_until(duration_secs as f32 + 1.0);
    }
    let zoom_full_precompute_ms = elapsed_ms(started);

    let mut lazy_first =
        build_zoom_interpolators(&segments, &cursor_timelines, &project_config, duration_secs);
    let started = Instant::now();
    for interpolator in &mut lazy_first {
        interpolator.ensure_precomputed_until(1.0 / cli.fps as f32);
    }
    let zoom_lazy_first_frame_ms = elapsed_ms(started);

    let mut lazy_all =
        build_zoom_interpolators(&segments, &cursor_timelines, &project_config, duration_secs);
    let started = Instant::now();
    for frame_number in 0..total_frames {
        let until = (frame_number as f32 + 1.0) / cli.fps as f32;
        for interpolator in &mut lazy_all {
            interpolator.ensure_precomputed_until(until);
        }
    }
    let zoom_lazy_all_frames_ms = elapsed_ms(started);

    let profile = ExportCpuStartupProfile {
        project: cli.path.display().to_string(),
        fps: cli.fps,
        duration_secs,
        total_frames,
        recording_meta_load_ms,
        project_config_load_ms,
        recordings_meta_load_ms,
        segment_media_load_ms,
        precomputed_cursor_timelines_ms,
        zoom_interpolator_construct_ms,
        zoom_full_precompute_ms,
        zoom_lazy_first_frame_ms,
        zoom_lazy_all_frames_ms,
        audio_mix_profile,
    };

    println!("{}", serde_json::to_string_pretty(&profile)?);

    Ok(())
}
