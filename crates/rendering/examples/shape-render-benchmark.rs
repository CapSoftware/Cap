use cap_project::{
    CursorEvents, ProjectConfiguration, RecordingMeta, ShapeAnimation, ShapeKind, ShapeSegment, XY,
};
use cap_rendering::{
    DecodedFrame, DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderOptions,
    RenderVideoConstants, RendererLayers, ZoomTransformTimeline,
};
use std::hint::black_box;
use std::time::Instant;

const FPS: u32 = 60;
const OUTPUT: XY<u32> = XY::new(1920, 1080);
const SCREEN: XY<u32> = XY::new(1920, 1080);

fn shapes(total: usize) -> Vec<ShapeSegment> {
    (0..total)
        .map(|index| {
            let kind = ShapeKind::ALL[index % ShapeKind::ALL.len()];
            let x = 0.04 + (index % 10) as f64 * 0.095;
            let y = 0.04 + ((index / 10) % 10) as f64 * 0.095;
            let mut shape =
                ShapeSegment::new(kind, 0.0, 10.0, XY::new(x + 0.04, y + 0.04), 16.0 / 9.0);
            shape.from = XY::new(x, y);
            shape.to = XY::new(x + 0.08, y + 0.08);
            shape.track = (index % 4) as u32;
            shape.number = index as u32 + 1;
            if index % 2 == 0 {
                shape.animation_in = ShapeAnimation::Draw;
                shape.animation_in_duration = 2.0;
            }
            shape
        })
        .collect()
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * fraction).round() as usize]
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let directory = tempfile::tempdir().unwrap();
    let mut metadata: RecordingMeta = serde_json::from_value(serde_json::json!({
        "pretty_name": "shape probe",
        "display": {"path": "unused.mp4", "fps": FPS},
        "camera": null, "audio": null, "cursor": null
    }))
    .unwrap();
    metadata.project_path = directory.path().to_path_buf();
    let studio = metadata.studio_meta().unwrap().clone();
    let constants = RenderVideoConstants::new_with_options(
        RenderOptions {
            screen_size: SCREEN,
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
        serde_json::json!({
            "adapter": constants.adapter_name(),
            "software": constants.is_software_adapter,
            "output": [OUTPUT.x, OUTPUT.y],
            "scope": "Synthetic decoded screen frame. prepare = ProjectUniforms::new; frame = render_immediate (upload, every layer, GPU work and readback wait). Excludes decode, encode and GPUI."
        })
    );
    let cursor = CursorEvents::default();
    let pixels: Vec<u8> = (0..(SCREEN.x * SCREEN.y))
        .flat_map(|index| {
            [
                (index % 251) as u8,
                ((index / SCREEN.x) % 241) as u8,
                89,
                255,
            ]
        })
        .collect();
    let frames = DecodedSegmentFrames {
        screen_size: SCREEN,
        screen_frame: Some(DecodedFrame::new(pixels, SCREEN.x, SCREEN.y)),
        camera_frame: None,
        segment_time: 0.0,
        recording_time: 0.0,
        segment_has_camera: false,
    };
    let rounds =
        std::env::var("CAP_SHAPE_PROBE_ROUNDS").map_or(5, |value| value.parse::<usize>().unwrap());
    let frames_per_round = 240;

    for total in [0, 20, 100] {
        let mut project = ProjectConfiguration {
            timeline: Some(
                serde_json::from_value(serde_json::json!({
                    "segments": [{"recordingSegment": 0, "start": 0.0, "end": 10.0, "timescale": 1.0}],
                    "zoomSegments": []
                }))
                .unwrap(),
            ),
            ..Default::default()
        };
        project.timeline.as_mut().unwrap().shape_segments = shapes(total);
        let zoom = ZoomTransformTimeline::from_project(&project, &cursor, 10.0, SCREEN);
        let project = std::sync::Arc::new(project);
        let prepare = |frame: u32| {
            ProjectUniforms::new(
                &constants, &project, frame, FPS, OUTPUT, &cursor, &frames, 10.0, &zoom,
            )
        };

        let start = Instant::now();
        let iterations = 2400u32;
        for frame in 0..iterations {
            black_box(prepare(frame % 240));
        }
        let prepare_us = start.elapsed().as_secs_f64() * 1.0e6 / f64::from(iterations);

        let mut layers = RendererLayers::new_with_options(
            &constants.device,
            &constants.queue,
            constants.is_software_adapter,
        );
        let mut renderer = FrameRenderer::new(&constants);
        for frame in 0..30 {
            renderer
                .render_immediate(frames.clone(), prepare(frame), &cursor, true, &mut layers)
                .await
                .unwrap();
        }
        let mut times = Vec::with_capacity(rounds * frames_per_round);
        for _ in 0..rounds {
            for frame in 0..frames_per_round as u32 {
                let uniforms = prepare(frame);
                let start = Instant::now();
                black_box(
                    renderer
                        .render_immediate(frames.clone(), uniforms, &cursor, true, &mut layers)
                        .await
                        .unwrap(),
                );
                times.push(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
        times.sort_by(f64::total_cmp);
        let mean = times.iter().sum::<f64>() / times.len() as f64;
        println!(
            "PROBE_RESULT {}",
            serde_json::json!({
                "shapes": total,
                "prepare_us": (prepare_us * 100.0).round() / 100.0,
                "frame_ms_mean": (mean * 1000.0).round() / 1000.0,
                "frame_ms_p50": (percentile(&times, 0.5) * 1000.0).round() / 1000.0,
                "frame_ms_p95": (percentile(&times, 0.95) * 1000.0).round() / 1000.0,
                "frame_ms_max": (percentile(&times, 1.0) * 1000.0).round() / 1000.0,
                "frames": times.len(),
            })
        );
    }
}
