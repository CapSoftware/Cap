use std::{
    path::PathBuf,
    sync::mpsc,
    time::{Duration, Instant},
};

use cap_editor::{EditorFrameOutput, EditorInstance, FrameLayout};
use cap_project::XY;

const FPS: u32 = 60;
const MOUSE_HZ: f64 = 120.0;

fn arg_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|idx| args.get(idx + 1))
        .map(String::as_str)
}

fn presented_frame(output: &EditorFrameOutput) -> u32 {
    match output {
        EditorFrameOutput::Rgba(frame) => frame.frame_number,
        EditorFrameOutput::Nv12(frame) => frame.frame_number,
        #[cfg(target_os = "macos")]
        EditorFrameOutput::Surface(frame) => frame.frame_number,
    }
}

struct SweepResult {
    requests: usize,
    presented: usize,
    longest_gap_ms: f64,
    settle_ms: f64,
}

async fn sweep(
    editor: &EditorInstance,
    frames_rx: &mpsc::Receiver<(Instant, u32)>,
    from: u32,
    to: u32,
    sweep_secs: f64,
    resolution: XY<u32>,
) -> SweepResult {
    while frames_rx.try_recv().is_ok() {}

    let steps = (sweep_secs * MOUSE_HZ).round().max(1.0) as usize;
    let interval = Duration::from_secs_f64(1.0 / MOUSE_HZ);
    let started = Instant::now();
    let mut presented = Vec::new();
    let mut last_send = started;
    let mut after_last_send = 0;

    for step in 0..=steps {
        let progress = step as f64 / steps as f64;
        let frame = (from as f64 + (to as f64 - from as f64) * progress).round() as u32;
        editor
            .preview_tx
            .send_modify(|value| *value = Some((frame, FPS, resolution)));
        last_send = Instant::now();
        after_last_send = presented.len();
        while let Ok(event) = frames_rx.try_recv() {
            presented.push(event);
        }
        if step < steps {
            let deadline = started + interval * (step as u32 + 1);
            tokio::time::sleep_until(deadline.into()).await;
        }
    }

    let already_presented = presented[after_last_send..]
        .iter()
        .find(|(_, frame)| *frame == to)
        .map(|(at, _)| *at);
    let final_at = match already_presented {
        Some(at) => at,
        None => loop {
            match frames_rx.recv_timeout(Duration::from_secs(10)) {
                Ok((at, frame)) => {
                    presented.push((at, frame));
                    if frame == to {
                        break at;
                    }
                }
                Err(_) => panic!("final frame {to} never presented"),
            }
        },
    };
    let settle_ms = final_at.saturating_duration_since(last_send).as_secs_f64() * 1000.0;

    let during_drag = || presented.iter().filter(|(at, _)| *at <= last_send);
    let presented_during_drag = during_drag().count();
    let mut longest_gap = Duration::ZERO;
    let mut previous = started;
    for (at, _) in during_drag() {
        longest_gap = longest_gap.max(at.saturating_duration_since(previous));
        previous = *at;
    }
    longest_gap = longest_gap.max(last_send.saturating_duration_since(previous));

    SweepResult {
        requests: steps + 1,
        presented: presented_during_drag,
        longest_gap_ms: longest_gap.as_secs_f64() * 1000.0,
        settle_ms,
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let recording_path = arg_value(&args, "--recording-path")
        .map(PathBuf::from)
        .expect("Usage: scrub-benchmark --recording-path <path> [--runs <count>]");
    let runs = arg_value(&args, "--runs")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(3)
        .max(1);
    let resolution = XY::new(960, 540);

    let (frames_tx, frames_rx) = mpsc::channel::<(Instant, u32)>();
    let editor = EditorInstance::new(
        recording_path.clone(),
        |_| {},
        Box::new(move |output: EditorFrameOutput, _: FrameLayout| {
            let _ = frames_tx.send((Instant::now(), presented_frame(&output)));
        }),
        None,
    )
    .await
    .expect("Failed to create editor instance");

    let timeline_duration = editor
        .project_config
        .1
        .borrow()
        .timeline
        .as_ref()
        .map(|timeline| timeline.duration());
    let duration = timeline_duration
        .unwrap_or_else(|| f64::from(editor.get_total_frames(FPS)) / f64::from(FPS));
    let last_frame = ((duration * FPS as f64).floor() as u32).saturating_sub(2);
    assert!(
        last_frame > 0,
        "the recording is too short to benchmark scrubbing"
    );

    editor
        .preview_tx
        .send_modify(|value| *value = Some((0, FPS, resolution)));
    frames_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("first preview frame");
    tokio::time::sleep(Duration::from_millis(500)).await;

    println!("Recording: {}", recording_path.display());
    println!(
        "Timeline: {duration:.1}s, preview {}x{}, mouse {MOUSE_HZ} Hz",
        resolution.x, resolution.y
    );

    let cases: [(&str, f64, bool); 4] = [
        ("fast drag, whole timeline in 2 s", 2.0, false),
        ("fast drag back", 2.0, true),
        ("slow drag, whole timeline in 8 s", 8.0, false),
        ("slow drag back", 8.0, true),
    ];
    for (name, secs, backward) in cases {
        let mut results = Vec::new();
        for _ in 0..runs {
            let (from, to) = if backward {
                (last_frame, 0)
            } else {
                (0, last_frame)
            };
            editor
                .preview_tx
                .send_modify(|value| *value = Some((from, FPS, resolution)));
            tokio::time::sleep(Duration::from_millis(800)).await;
            results.push(sweep(&editor, &frames_rx, from, to, secs, resolution).await);
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let mean =
            |f: fn(&SweepResult) -> f64| results.iter().map(f).sum::<f64>() / results.len() as f64;
        println!(
            "{name:<34} requests={:>4} presented={:>6.1} ({:>5.1}/s) longest_gap={:>7.1}ms settle={:>6.1}ms",
            results[0].requests,
            mean(|r| r.presented as f64),
            mean(|r| r.presented as f64) / secs,
            mean(|r| r.longest_gap_ms),
            mean(|r| r.settle_ms),
        );
    }

    let mut seek_ms = Vec::new();
    let mut seed = 0x2545F4914F6CDD1Du64;
    for _ in 0..30 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let target = (seed % u64::from(last_frame)) as u32;
        while frames_rx.try_recv().is_ok() {}
        let sent = Instant::now();
        editor
            .preview_tx
            .send_modify(|value| *value = Some((target, FPS, resolution)));
        loop {
            let (at, frame) = frames_rx
                .recv_timeout(Duration::from_secs(10))
                .expect("seek target never presented");
            if frame == target {
                seek_ms.push(at.saturating_duration_since(sent).as_secs_f64() * 1000.0);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    seek_ms.sort_by(f64::total_cmp);
    println!(
        "{:<34} p50={:>6.1}ms p90={:>6.1}ms max={:>6.1}ms",
        "single random seek (idle)",
        seek_ms[seek_ms.len() / 2],
        seek_ms[seek_ms.len() * 9 / 10],
        seek_ms[seek_ms.len() - 1]
    );

    editor.dispose().await;
}
