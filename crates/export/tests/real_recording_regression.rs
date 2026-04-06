use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
};

use cap_editor::create_segments;
use cap_project::{ProjectConfiguration, RecordingMeta, XY};
use cap_rendering::{
    FrameRenderer, PrecomputedCursorTimeline, ProjectRecordingsMeta, ProjectUniforms,
    RenderSegment, RenderVideoConstants, RenderedFrame, RendererLayers, ZoomFocusInterpolator,
    render_video_to_channel, spring_mass_damper::SpringMassDamperSimulationConfig,
};

fn real_recording_path() -> Option<PathBuf> {
    std::env::var_os("CAP_REAL_RECORDING_PATH")
        .map(PathBuf::from)
        .filter(|path| path.exists())
}

fn sampled_frame_numbers() -> BTreeSet<u32> {
    (0..12).chain(90..102).chain(160..172).collect()
}

fn sampled_mean_abs_diff(a: &[u8], b: &[u8]) -> f64 {
    let len = a.len().min(b.len());
    if len == 0 {
        return 0.0;
    }

    let sample_count = 4096usize.min(len);
    let step = (len / sample_count).max(1);

    let mut total = 0u64;
    let mut compared = 0u64;
    let mut index = 0usize;

    while index < len && compared < sample_count as u64 {
        total += a[index].abs_diff(b[index]) as u64;
        compared += 1;
        index = index.saturating_add(step);
    }

    total as f64 / compared as f64
}

struct RenderSampledSequenceFramesParams<'a> {
    render_constants: &'a Arc<RenderVideoConstants>,
    project_config: &'a ProjectConfiguration,
    recording_meta: &'a RecordingMeta,
    studio_meta: &'a cap_project::StudioRecordingMeta,
    recordings: &'a Arc<ProjectRecordingsMeta>,
    resolution_base: XY<u32>,
    force_ffmpeg_decoder: bool,
    sample_frames: &'a BTreeSet<u32>,
}

async fn render_sampled_sequence_frames(
    params: RenderSampledSequenceFramesParams<'_>,
) -> Result<BTreeMap<u32, RenderedFrame>, Box<dyn std::error::Error>> {
    let RenderSampledSequenceFramesParams {
        render_constants,
        project_config,
        recording_meta,
        studio_meta,
        recordings,
        resolution_base,
        force_ffmpeg_decoder,
        sample_frames,
    } = params;

    let segments = create_segments(recording_meta, studio_meta, force_ffmpeg_decoder)
        .await
        .map_err(std::io::Error::other)?;

    let render_segments: Vec<RenderSegment> = segments
        .iter()
        .map(|segment| RenderSegment {
            cursor: segment.cursor.clone(),
            keyboard: segment.keyboard.clone(),
            decoders: segment.decoders.clone(),
            render_display: true,
        })
        .collect();

    let expected_frames = sample_frames.clone();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<(RenderedFrame, u32)>(16);
    let collect_frames = tokio::spawn(async move {
        let mut frames = BTreeMap::new();
        while let Some((frame, _)) = rx.recv().await {
            if expected_frames.contains(&frame.frame_number) {
                frames.insert(frame.frame_number, frame);
            }
        }
        frames
    });

    render_video_to_channel(
        render_constants,
        project_config,
        tx,
        recording_meta,
        studio_meta,
        render_segments,
        60,
        resolution_base,
        recordings,
    )
    .await
    .map_err(std::io::Error::other)?;

    let sequence_frames = collect_frames.await?;
    assert_eq!(sequence_frames.len(), sample_frames.len());
    Ok(sequence_frames)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn export_sequence_render_matches_editor_reference_for_real_recording()
-> Result<(), Box<dyn std::error::Error>> {
    let Some(project_path) = real_recording_path() else {
        println!("Skipping test: CAP_REAL_RECORDING_PATH is not set");
        return Ok(());
    };

    let recording_meta = RecordingMeta::load_for_project(&project_path)?;
    let Some(studio_meta) = recording_meta.studio_meta() else {
        return Err("Recording is not a studio recording".into());
    };

    let project_config = recording_meta.project_config();
    let recordings = Arc::new(
        ProjectRecordingsMeta::new(&recording_meta.project_path, studio_meta)
            .map_err(std::io::Error::other)?,
    );
    let render_constants = Arc::new(
        RenderVideoConstants::new(
            &recordings.segments,
            recording_meta.clone(),
            studio_meta.clone(),
        )
        .await
        .map_err(std::io::Error::other)?,
    );
    let total_duration = project_config
        .timeline
        .as_ref()
        .map(|timeline| timeline.duration())
        .unwrap_or_else(|| recordings.duration());
    let cursor_smoothing =
        (!project_config.cursor.raw).then_some(SpringMassDamperSimulationConfig {
            tension: project_config.cursor.tension,
            mass: project_config.cursor.mass,
            friction: project_config.cursor.friction,
        });
    let click_spring = project_config.cursor.click_spring_config();
    let sample_frames = sampled_frame_numbers();
    let max_sample_frame = *sample_frames
        .iter()
        .next_back()
        .ok_or("No sample frames configured")?;

    for resolution_base in [XY::new(1920, 1080), XY::new(3840, 2160)] {
        let sequence_frames = render_sampled_sequence_frames(RenderSampledSequenceFramesParams {
            render_constants: &render_constants,
            project_config: &project_config,
            recording_meta: &recording_meta,
            studio_meta,
            recordings: &recordings,
            resolution_base,
            force_ffmpeg_decoder: false,
            sample_frames: &sample_frames,
        })
        .await?;

        let reference_segments = create_segments(&recording_meta, studio_meta, false)
            .await
            .map_err(std::io::Error::other)?;
        let reference_render_segments: Vec<RenderSegment> = reference_segments
            .iter()
            .map(|segment| RenderSegment {
                cursor: segment.cursor.clone(),
                keyboard: segment.keyboard.clone(),
                decoders: segment.decoders.clone(),
                render_display: true,
            })
            .collect();

        let precomputed_cursor_timelines: Vec<Arc<PrecomputedCursorTimeline>> =
            reference_render_segments
                .iter()
                .map(|segment| {
                    Arc::new(PrecomputedCursorTimeline::new(
                        &segment.cursor,
                        cursor_smoothing,
                        Some(click_spring),
                    ))
                })
                .collect();

        let mut zoom_focus_interpolators: Vec<ZoomFocusInterpolator> = reference_render_segments
            .iter()
            .zip(precomputed_cursor_timelines.iter())
            .map(|(segment, precomputed_cursor)| {
                ZoomFocusInterpolator::new_with_precomputed_cursor(
                    &segment.cursor,
                    cursor_smoothing,
                    click_spring,
                    project_config.screen_movement_spring,
                    total_duration,
                    project_config
                        .timeline
                        .as_ref()
                        .map(|timeline| timeline.zoom_segments.as_slice())
                        .unwrap_or(&[]),
                    Some(precomputed_cursor.clone()),
                )
            })
            .collect();

        let mut renderer = FrameRenderer::new(&render_constants);
        let mut layers = RendererLayers::new_with_options(
            &render_constants.device,
            &render_constants.queue,
            render_constants.is_software_adapter,
        );

        if let Some(first_segment) = reference_render_segments.first() {
            let (screen_w, screen_h) = first_segment.decoders.screen_video_dimensions();
            let camera_dims = first_segment.decoders.camera_video_dimensions();
            layers.prepare_for_video_dimensions(
                &render_constants.device,
                screen_w,
                screen_h,
                camera_dims.map(|(w, _)| w),
                camera_dims.map(|(_, h)| h),
            );
        }

        let mut previous_reference: Option<RenderedFrame> = None;
        for frame_number in 0..=max_sample_frame {
            let Some((segment_time, timeline_segment)) =
                project_config.get_segment_time(frame_number as f64 / 60.0)
            else {
                return Err(format!("Missing timeline segment for frame {frame_number}").into());
            };

            let clip_index = timeline_segment.recording_clip as usize;
            let render_segment = &reference_render_segments[clip_index];
            let clip_config = project_config
                .clips
                .iter()
                .find(|clip| clip.index == timeline_segment.recording_clip);

            let zoom_until = (frame_number as f32 + 1.0) / 60.0;
            zoom_focus_interpolators[clip_index].ensure_precomputed_until(zoom_until);

            let decoded = render_segment
                .decoders
                .get_frames(
                    segment_time as f32,
                    !project_config.camera.hide,
                    render_segment.render_display,
                    clip_config.map(|clip| clip.offsets).unwrap_or_default(),
                )
                .await
                .ok_or_else(|| format!("Failed to decode reference frame {frame_number}"))?;

            let uniforms = ProjectUniforms::new_with_precomputed_cursor(
                &render_constants,
                &project_config,
                frame_number,
                60,
                resolution_base,
                &render_segment.cursor,
                &decoded,
                total_duration,
                &zoom_focus_interpolators[clip_index],
                &precomputed_cursor_timelines[clip_index],
            );

            let reference = renderer
                .render_immediate(
                    decoded,
                    uniforms,
                    &render_segment.cursor,
                    render_segment.render_display,
                    &mut layers,
                )
                .await
                .map_err(std::io::Error::other)?;

            if sample_frames.contains(&frame_number) {
                let Some(sequence_frame) = sequence_frames.get(&frame_number) else {
                    return Err(format!("Missing sequence frame {frame_number}").into());
                };

                assert_eq!(reference.frame_number, sequence_frame.frame_number);
                assert_eq!(reference.width, sequence_frame.width);
                assert_eq!(reference.height, sequence_frame.height);
                assert_eq!(
                    reference.padded_bytes_per_row,
                    sequence_frame.padded_bytes_per_row
                );
                if reference.data.as_ref() != sequence_frame.data.as_ref() {
                    let current_diff = sampled_mean_abs_diff(
                        reference.data.as_ref(),
                        sequence_frame.data.as_ref(),
                    );
                    let previous_diff = previous_reference.as_ref().map(|previous| {
                        sampled_mean_abs_diff(previous.data.as_ref(), sequence_frame.data.as_ref())
                    });
                    panic!(
                        "resolution={}x{} frame={} current_diff={current_diff:.3} previous_diff={previous_diff:?}",
                        resolution_base.x, resolution_base.y, frame_number
                    );
                }
            }

            previous_reference = Some(reference);
        }
    }

    Ok(())
}
