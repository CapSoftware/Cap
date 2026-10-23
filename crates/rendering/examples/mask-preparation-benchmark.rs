use cap_project::{CursorEvents, MaskKind, MaskSegment, ProjectConfiguration, RecordingMeta, XY};
use cap_rendering::{
    DecodedFrame, DecodedSegmentFrames, FrameRenderer, MaskRenderMode, ProjectUniforms,
    RenderOptions, RenderVideoConstants, RendererLayers, ZoomTransformTimeline,
};
use std::hint::black_box;
use std::time::Instant;

fn segment(index: usize, total: usize, active: usize) -> MaskSegment {
    let active = total > 0 && (index * 97) % total < active;
    MaskSegment {
        start: if active { 0.0 } else { 20.0 + index as f64 },
        end: if active { 10.0 } else { 30.0 + index as f64 },
        track: ((index * 97) % 31) as u32,
        enabled: true,
        mask_type: if index.is_multiple_of(2) {
            MaskKind::Sensitive
        } else {
            MaskKind::Highlight
        },
        center: XY::new((index % 10) as f64 / 10.0, 0.5),
        size: XY::new(0.25, 0.25),
        feather: 0.1,
        opacity: 0.7,
        pixelation: 18.0,
        darkness: 0.5,
        fade_duration: 0.15,
        keyframes: Default::default(),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let directory = tempfile::tempdir().unwrap();
    let mut metadata: RecordingMeta = serde_json::from_value(serde_json::json!({
        "pretty_name": "mask probe",
        "display": {"path": "unused.mp4", "fps": 60},
        "camera": null, "audio": null, "cursor": null
    }))
    .unwrap();
    metadata.project_path = directory.path().to_path_buf();
    let studio = metadata.studio_meta().unwrap().clone();
    let constants = RenderVideoConstants::new_with_options(
        RenderOptions {
            screen_size: XY::new(320, 180),
            camera_size: None,
            preserve_screen_alpha: false,
        },
        metadata,
        studio,
    )
    .await
    .unwrap();
    println!(
        "PROBE_INFO {}",
        serde_json::json!({"adapter": constants.adapter_name(), "software": constants.is_software_adapter,
        "scope": "Native full ProjectUniforms preparation. Synthetic decoded input. Excludes GPU submission, decode, encode, GPUI scheduling and display."})
    );
    let cursor = CursorEvents::default();
    let frames = DecodedSegmentFrames {
        screen_size: XY::new(320, 180),
        screen_frame: None,
        camera_frame: None,
        segment_time: 0.0,
        recording_time: 0.0,
        segment_has_camera: false,
    };
    let samples =
        std::env::var("CAP_MASK_PROBE_SAMPLES").map_or(16, |value| value.parse::<usize>().unwrap());
    let output = std::path::PathBuf::from(std::env::var("CAP_MASK_PROBE_OUTPUT").unwrap());
    std::fs::create_dir_all(&output).unwrap();
    for (name, total, active) in [
        ("empty", 0, 0),
        ("eight_all_active", 8, 8),
        ("64_one_active", 64, 1),
        ("256_four_active", 256, 4),
        ("1024_four_active", 1024, 4),
        ("256_all_active", 256, 256),
    ] {
        let mut project = ProjectConfiguration {
            background: cap_project::BackgroundConfiguration { shadow: 0.0, advanced_shadow: None, ..Default::default() },
            timeline: Some(serde_json::from_value(serde_json::json!({
                "segments": [{"recordingSegment": 0, "start": 0.0, "end": 10.0, "timescale": 1.0}],
                "zoomSegments": []
            })).unwrap()),
            screen_motion_blur: 0.0,
            ..Default::default()
        };
        project.timeline.as_mut().unwrap().mask_segments = (0..total)
            .map(|index| segment(index, total, active))
            .collect();
        let zoom = ZoomTransformTimeline::from_project(
            &project,
            &cursor,
            10.0,
            constants.options.screen_size,
        );
        let project = std::sync::Arc::new(project);
        let prepare = |frame: u32| {
            ProjectUniforms::new(
                &constants,
                &project,
                frame,
                60,
                XY::new(1920, 1080),
                &cursor,
                &frames,
                10.0,
                &zoom,
            )
        };
        let calibration = Instant::now();
        for frame in 0..1200 {
            black_box(prepare(60 + frame % 120));
        }
        let per_frame = calibration.elapsed().as_nanos() as f64 / 1200.0;
        let iterations =
            ((30_000_000.0 / per_frame).clamp(120.0, 1_000_000.0) as usize / 120).max(1) * 120;
        for sample in 0..samples {
            let start = Instant::now();
            for frame in 0..iterations {
                black_box(prepare(60 + (frame % 120) as u32));
            }
            let elapsed = start.elapsed().as_nanos();
            println!(
                "PROBE_SAMPLE {}",
                serde_json::json!({"case": name, "total": total,
                "active": active, "sample": sample, "iterations": iterations,
                "elapsed_ns": elapsed, "ns_per_frame": elapsed as f64 / iterations as f64})
            );
        }
        let uniforms = prepare(120);
        assert_eq!(uniforms.masks.len(), active);
        let mask_bits = uniforms
            .masks
            .iter()
            .map(|mask| {
                [
                    mask.track as u64,
                    mask.center.x.to_bits() as u64,
                    mask.center.y.to_bits() as u64,
                    mask.size.x.to_bits() as u64,
                    mask.size.y.to_bits() as u64,
                    mask.feather.to_bits() as u64,
                    mask.opacity.to_bits() as u64,
                    mask.effect_size.to_bits() as u64,
                    mask.darkness.to_bits() as u64,
                    match mask.mode {
                        MaskRenderMode::Pixelate => 0,
                        MaskRenderMode::Highlight => 1,
                        MaskRenderMode::Blur => 2,
                    },
                ]
            })
            .collect::<Vec<_>>();
        let mut layers = RendererLayers::new_with_options(
            &constants.device,
            &constants.queue,
            constants.is_software_adapter,
        );
        let pixels = (0..(320 * 180))
            .flat_map(|index| [(index % 255) as u8, ((index / 320) % 255) as u8, 89, 255])
            .collect();
        let image_frames = DecodedSegmentFrames {
            screen_frame: Some(DecodedFrame::new(pixels, 320, 180)),
            ..frames.clone()
        };
        let rendered = FrameRenderer::new(&constants)
            .render_immediate(image_frames, uniforms, &cursor, true, &mut layers)
            .await
            .unwrap();
        let packed = rendered
            .data
            .chunks_exact(rendered.padded_bytes_per_row as usize)
            .take(rendered.height as usize)
            .flat_map(|row| row[..rendered.width as usize * 4].iter().copied())
            .collect::<Vec<_>>();
        std::fs::write(output.join(format!("{name}.rgba")), packed).unwrap();
        std::fs::write(
            output.join(format!("{name}.json")),
            serde_json::to_vec_pretty(&serde_json::json!({
                "width": rendered.width, "height": rendered.height, "mask_bits": mask_bits,
            }))
            .unwrap(),
        )
        .unwrap();
    }
}
