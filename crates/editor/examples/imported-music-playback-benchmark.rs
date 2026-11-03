use cap_editor::{AudioOutput, EditorFrameOutput, EditorInstance, PlaybackEvent};
use cap_project::{
    AudioTrackSegment, ClipConfiguration, ProjectConfiguration, RecordingMeta, TimelineSegment, XY,
};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    ffmpeg::init().unwrap();
    let root = PathBuf::from(std::env::args_os().nth(1).expect("fixture directory"));
    let count: usize = std::env::args()
        .nth(2)
        .unwrap_or("2".into())
        .parse()
        .unwrap();
    assert!((1..=2).contains(&count));
    let mut project = ProjectConfiguration {
        timeline: Some(
            serde_json::from_value(serde_json::json!({"segments":[],"zoomSegments":[]})).unwrap(),
        ),
        ..Default::default()
    };
    project.camera.hide = true;
    project.cursor.hide = true;
    project.clips = vec![ClipConfiguration {
        index: 0,
        ..Default::default()
    }];
    let timeline = project.timeline.as_mut().unwrap();
    timeline.segments = vec![TimelineSegment {
        recording_clip: 0,
        start: 0.0,
        end: 1200.0,
        timescale: 1.0,
        ..Default::default()
    }];
    for path in ["music-a.m4a", "music-b.m4a"].into_iter().take(count) {
        timeline.audio_segments.push(AudioTrackSegment {
            start: 0.0,
            end: 1200.0,
            track: 0,
            path: path.into(),
            name: None,
            enabled: true,
            trim_start: 0.0,
            volume_db: -12.0,
            fade_in: 0.0,
            fade_out: 0.0,
            duration: Some(3600.0),
        });
    }
    let delayed_cold = std::env::args().nth(3).as_deref() == Some("delayed-cold");
    let playback_project = project.clone();
    if delayed_cold {
        project.timeline.as_mut().unwrap().audio_segments.clear();
    }
    project.write(&root).unwrap();
    let mut meta: RecordingMeta = serde_json::from_value(serde_json::json!({
        "platform":"Linux","pretty_name":"Imported music playback benchmark","sharing":null,
        "segments":[{"display":{"path":"display.mp4","fps":1,"start_time":0.0}}],
        "cursors":{},"status":{"status":"Complete"}
    }))
    .unwrap();
    meta.project_path = root.clone();
    meta.save_for_project().unwrap();
    let (audio_tx, mut audio_rx) = tokio::sync::mpsc::unbounded_channel();
    let output = Arc::new(AudioOutput::new_headless(Box::new(move |samples, _| {
        if samples.iter().any(|sample| sample.abs() > 0.00001) {
            let _ = audio_tx.send(Instant::now());
        }
    })));
    let (frame_tx, mut frame_rx) = tokio::sync::mpsc::unbounded_channel();
    let opened = Instant::now();
    let editor = EditorInstance::new_with_audio_output(
        root,
        |_| {},
        Box::new(move |frame, _| {
            let number = match frame {
                EditorFrameOutput::Rgba(frame) => frame.frame_number,
                EditorFrameOutput::Nv12(frame) => frame.frame_number,
                #[cfg(target_os = "macos")]
                EditorFrameOutput::Surface(frame) => frame.frame_number,
            };
            let _ = frame_tx.send((number, Instant::now()));
        }),
        None,
        output,
    )
    .await
    .unwrap();
    let open_seconds = opened.elapsed().as_secs_f64();
    if delayed_cold {
        tokio::time::sleep(Duration::from_millis(250)).await;
        editor.project_config.0.send(playback_project).unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    for phase in [
        if delayed_cold {
            "delayed-cold"
        } else {
            "immediate"
        },
        "warm",
    ] {
        while audio_rx.try_recv().is_ok() {}
        while frame_rx.try_recv().is_ok() {}
        let start_frame = if phase == "warm" { 900 } else { 0 };
        let started = Instant::now();
        let mut handle = tokio::time::timeout(
            Duration::from_secs(30),
            editor.start_playback_with_handle(15, XY::new(640, 360), Some(start_frame)),
        )
        .await
        .unwrap()
        .unwrap();
        let start_return_seconds = started.elapsed().as_secs_f64();
        let first_audio = tokio::time::timeout(Duration::from_secs(20), audio_rx.recv())
            .await
            .unwrap()
            .unwrap();
        let (observed_frame, first_frame) = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let (number, timestamp) = frame_rx.recv().await.unwrap();
                if number >= start_frame && number < start_frame + 150 {
                    break (number, timestamp);
                }
            }
        })
        .await
        .unwrap();
        println!(
            "MUSIC_PLAYBACK {}",
            serde_json::json!({"tracks":count,"phase":phase,"start_frame":start_frame,"observed_frame":observed_frame,"open_seconds":open_seconds,"start_return_seconds":start_return_seconds,"first_audio_seconds":first_audio.saturating_duration_since(started).as_secs_f64(),"first_frame_seconds":first_frame.saturating_duration_since(started).as_secs_f64(),"open_to_audio_seconds":first_audio.saturating_duration_since(opened).as_secs_f64()})
        );
        handle.stop();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if matches!(*handle.receive_event().await, PlaybackEvent::Stop) {
                    break;
                }
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    editor.dispose().await;
}
