use cap_export::{
    ExporterBase,
    mp4::{ExportCompression, Mp4ExportSettings},
};
use cap_project::{ClipConfiguration, ProjectConfiguration, RecordingMeta, TimelineSegment, XY};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Instant,
};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let root = PathBuf::from(std::env::args_os().nth(1).expect("fixture directory"));
    let output = PathBuf::from(std::env::args_os().nth(2).expect("output MP4 path"));
    let gap: f64 = std::env::var("CAP_EXPORT_CUT_GAP").map_or(0.1, |v| v.parse().unwrap());
    let mut project = ProjectConfiguration {
        timeline: Some(
            serde_json::from_value(serde_json::json!({"segments":[],"zoomSegments":[]})).unwrap(),
        ),
        ..Default::default()
    };
    project.audio.improve = true;
    project.camera.hide = true;
    project.cursor.hide = true;
    project.cursor.raw = true;
    project.clips = vec![ClipConfiguration {
        index: 0,
        ..Default::default()
    }];
    project.timeline.as_mut().unwrap().segments = vec![
        TimelineSegment {
            recording_clip: 0,
            start: 0.0,
            end: 4.0,
            timescale: 1.0,
            ..Default::default()
        },
        TimelineSegment {
            recording_clip: 0,
            start: 4.0 + gap,
            end: 8.0 + gap,
            timescale: 1.0,
            ..Default::default()
        },
    ];
    project.write(&root).unwrap();
    let mut meta: RecordingMeta = serde_json::from_value(serde_json::json!({
        "platform":"Linux", "pretty_name":"Studio Sound cut benchmark", "sharing":null,
        "segments":[{
            "display":{"path":"display.mp4","fps":1,"start_time":0.0},
            "mic":{"path":"mic.wav","start_time":0.0}
        }],
        "cursors":{},"status":{"status":"Complete"}
    }))
    .unwrap();
    meta.project_path = root.clone();
    meta.save_for_project().unwrap();
    let first_progress = Arc::new(AtomicU64::new(u64::MAX));
    let recorded_progress = first_progress.clone();
    let start = Instant::now();
    let base = ExporterBase::builder(root)
        .with_output_path(output.clone())
        .with_force_ffmpeg_decoder(true)
        .build_for_mp4(Arc::new(AtomicBool::new(false)))
        .await
        .expect("export preparation");
    let build_seconds = start.elapsed().as_secs_f64();
    let streaming = base.uses_streaming_audio();
    let settings = Mp4ExportSettings {
        fps: 15,
        resolution_base: XY::new(640, 360),
        compression: ExportCompression::Web,
        custom_bpp: None,
        force_ffmpeg_decoder: true,
        optimize_filesize: false,
    };
    let export_start = Instant::now();
    settings
        .export_prepared(base, move |_| {
            recorded_progress
                .compare_exchange(
                    u64::MAX,
                    start.elapsed().as_micros() as u64,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                )
                .ok();
            true
        })
        .await
        .expect("complete export");
    let export_seconds = export_start.elapsed().as_secs_f64();
    let total_seconds = start.elapsed().as_secs_f64();
    let maxrss_kib = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status.lines().find_map(|line| {
                line.strip_prefix("VmHWM:")?
                    .split_whitespace()
                    .next()?
                    .parse::<u64>()
                    .ok()
            })
        });
    println!(
        "EXPORT_BENCH {}",
        serde_json::json!({
            "gap":gap,"streaming_audio":streaming,"build_seconds":build_seconds,
            "first_progress_seconds":first_progress.load(Ordering::Relaxed) as f64 / 1_000_000.0,
            "export_seconds":export_seconds,"total_seconds":total_seconds,"maxrss_kib":maxrss_kib,
            "output":output
        })
    );
}
