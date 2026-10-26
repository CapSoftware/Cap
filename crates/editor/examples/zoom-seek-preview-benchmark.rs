use cap_editor::{EditorFrameOutput, EditorInstance};
use cap_project::{
    ClipConfiguration, CursorEvents, CursorMoveEvent, GlideDirection, ProjectConfiguration,
    RecordingMeta, TimelineSegment, XY, ZoomMode, ZoomSegment,
};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::PathBuf,
    sync::mpsc,
    time::{Duration, Instant},
};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let root = PathBuf::from(std::env::args_os().nth(1).expect("fixture directory"));
    let duration: f64 = std::env::var("CAP_ZOOM_DURATION").map_or(3600.0, |v| v.parse().unwrap());
    let clips: usize = std::env::var("CAP_ZOOM_CLIPS").map_or(1000, |v| v.parse().unwrap());
    let mut project = ProjectConfiguration {
        timeline: Some(
            serde_json::from_value(serde_json::json!({"segments":[],"zoomSegments":[]})).unwrap(),
        ),
        ..Default::default()
    };
    project.camera.hide = true;
    project.cursor.hide = true;
    project.cursor.raw = true;
    project.clips = (0..4)
        .map(|index| ClipConfiguration {
            index,
            ..Default::default()
        })
        .collect();
    let timeline = project.timeline.as_mut().unwrap();
    let length = duration / clips as f64;
    timeline.segments = (0..clips)
        .map(|index| TimelineSegment {
            recording_clip: (index % 4) as u32,
            start: (index / 4) as f64 * length,
            end: ((index / 4) + 1) as f64 * length,
            timescale: 1.0,
            ..Default::default()
        })
        .collect();
    timeline.zoom_segments = (0..30)
        .map(|index| ZoomSegment {
            start: index as f64 * duration / 30.0,
            end: (index as f64 + 0.85) * duration / 30.0,
            amount: 2.0,
            mode: ZoomMode::Auto,
            glide_direction: GlideDirection::default(),
            glide_speed: 0.5,
            instant_animation: false,
            edge_snap_ratio: 0.25,
        })
        .collect();
    project.write(&root).unwrap();
    let cursor = CursorEvents {
        moves: (0..=(duration / 4.0 * 60.0) as usize)
            .map(|index| CursorMoveEvent {
                time_ms: index as f64 * 1000.0 / 60.0,
                x: 0.2 + (index % 700) as f64 / 1200.0,
                y: 0.2 + (index % 900) as f64 / 1500.0,
                cursor_id: "default".into(),
                active_modifiers: Vec::new(),
            })
            .collect(),
        ..Default::default()
    };
    std::fs::write(
        root.join("cursor.json"),
        serde_json::to_vec(&cursor).unwrap(),
    )
    .unwrap();
    let mut meta: RecordingMeta = serde_json::from_value(serde_json::json!({
        "platform":"Linux", "pretty_name":"Dense zoom seek benchmark", "sharing":null,
        "segments":(0..4).map(|_|serde_json::json!({"display":{"path":"display.mp4","fps":1,"start_time":0.0},"cursor":"cursor.json"})).collect::<Vec<_>>(),
        "cursors":{},"status":{"status":"Complete"}
    })).unwrap();
    meta.project_path = root.clone();
    meta.save_for_project().unwrap();
    let (tx, rx) = mpsc::channel();
    let startup = Instant::now();
    let editor = EditorInstance::new(
        root,
        |_| {},
        Box::new(move |output, _| {
            if let EditorFrameOutput::Rgba(frame) = output {
                let _ = tx.send((Instant::now(), frame));
            }
        }),
        None,
    )
    .await
    .expect("editor startup");
    let setup_seconds = startup.elapsed().as_secs_f64();
    editor
        .preview_tx
        .send_modify(|value| *value = Some((0, 30, XY::new(640, 360))));
    loop {
        let (_, frame) = rx
            .recv_timeout(Duration::from_secs(60))
            .expect("initial frame");
        if frame.frame_number == 0 {
            break;
        }
    }
    let target = (duration * 0.95 * 30.0) as u32;
    let start = Instant::now();
    editor
        .preview_tx
        .send_modify(|value| *value = Some((target, 30, XY::new(640, 360))));
    let (ready, frame) = loop {
        let value = rx
            .recv_timeout(Duration::from_secs(60))
            .expect("late seek frame");
        if value.1.frame_number == target {
            break value;
        }
    };
    let elapsed = ready.saturating_duration_since(start).as_secs_f64();
    let mut hash = DefaultHasher::new();
    for row in frame
        .data
        .chunks_exact(frame.padded_bytes_per_row as usize)
        .take(frame.height as usize)
    {
        row[..frame.width as usize * 4].hash(&mut hash);
    }
    println!(
        "PREVIEW_BENCH {}",
        serde_json::json!({"duration":duration,"clips":clips,"startup_seconds":setup_seconds,"seek_seconds":elapsed,"fingerprint":hash.finish(),"width":frame.width,"height":frame.height})
    );
    editor.dispose().await;
}
