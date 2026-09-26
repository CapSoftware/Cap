//! Chunk engine for distributed Studio exports.
//!
//! One long-lived process per render slot. It reads one JSON request per line
//! on stdin and answers with one JSON line on stdout; logs go to stderr. The
//! orchestration (planning, source byte ranges, uploads, MP4 assembly) lives
//! in `apps/render-farm`; this binary only does what needs Cap's renderer:
//!
//! - `probe`: frame count, output size and the source-time span each chunk
//!   reads, for the coordinator's plan.
//! - `video`: render + encode one output frame range to raw H.264 samples.
//! - `audio`: render + encode one output sample range to raw AAC packets on
//!   the global packet grid, with pre-roll so sections join seamlessly.

mod audio;
mod project;
mod video;

use anyhow::Result;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    sync::Mutex,
    time::Instant,
};

/// Id of the request being served, so long ops can stream progress lines.
static CURRENT_REQUEST: Mutex<Option<Value>> = Mutex::new(None);

/// `{"id": .., "progress": frames}` on stdout; the orchestrator uses it to
/// spot chunks that are running slow and hedge them on another machine.
pub fn report_progress(frames: u32) {
    let Ok(current) = CURRENT_REQUEST.lock() else {
        return;
    };
    let Some(id) = current.as_ref() else {
        return;
    };
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{}", json!({ "id": id, "progress": frames }));
    let _ = stdout.flush();
}

/// `{"id": .., <key>: <value>}` on stdout: streaming events for the request
/// in flight (e.g. finished GOPs the worker can publish as HLS segments).
pub fn report_event(key: &str, value: Value) {
    let Ok(current) = CURRENT_REQUEST.lock() else {
        return;
    };
    let Some(id) = current.as_ref() else {
        return;
    };
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{}", json!({ "id": id, key: value }));
    let _ = stdout.flush();
}

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    id: Value,
    #[serde(flatten)]
    op: Op,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Op {
    Probe(ProbeRequest),
    Video(video::VideoRequest),
    Audio(audio::AudioRequest),
    Warm,
    Ping,
}

#[derive(Deserialize)]
struct ProbeRequest {
    project: PathBuf,
    fps: u32,
    resolution: [u32; 2],
    /// Report source spans for every `span_step` output frames, so the
    /// coordinator can size chunks without another round trip.
    #[serde(default)]
    span_step: Option<u32>,
}

async fn probe(request: ProbeRequest) -> Result<Value> {
    let project = project::LoadedProject::load(&request.project)?;
    let total_frames = project.total_frames(request.fps);
    let (width, height) = project.output_size(request.resolution)?;
    let step = request.span_step.unwrap_or(request.fps * 2).max(1);
    let spans = (0..total_frames)
        .step_by(step as usize)
        .map(|start| project.source_spans(request.fps, [start, (start + step).min(total_frames)]))
        .collect::<Vec<_>>();
    let clips = project
        .config
        .clips
        .iter()
        .map(|clip| json!({ "index": clip.index, "camera": clip.offsets.camera, "mic": clip.offsets.mic }))
        .collect::<Vec<_>>();
    Ok(json!({
        "total_frames": total_frames,
        "duration": project.duration(),
        "width": width,
        "height": height,
        "total_samples": total_frames as i64 * audio::SAMPLE_RATE / request.fps as i64,
        "span_step": step,
        "spans": spans,
        "audio_cuts": project.audio_cuts(request.fps, audio::SAMPLE_RATE),
        "clips": clips,
    }))
}

async fn handle(op: Op) -> Result<Value> {
    Ok(match op {
        Op::Probe(request) => probe(request).await?,
        Op::Video(request) => serde_json::to_value(video::render(request).await?)?,
        Op::Audio(request) => serde_json::to_value(audio::render(request).await?)?,
        Op::Warm => video::warm().await?,
        Op::Ping => json!({ "pong": true }),
    })
}

fn main() -> Result<()> {
    cap_rendering::enable_blur_result_cache();
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "warn,cap_render_farm=info".into()),
        )
        .init();
    ffmpeg::init()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("once") {
        let line = args.next().unwrap_or_default();
        let request: Request = serde_json::from_str(&line)?;
        let result = runtime.block_on(handle(request.op))?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let started = Instant::now();
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(request) => {
                let id = request.id.clone();
                if let Ok(mut current) = CURRENT_REQUEST.lock() {
                    *current = Some(id.clone());
                }
                let result = runtime.block_on(handle(request.op));
                if let Ok(mut current) = CURRENT_REQUEST.lock() {
                    *current = None;
                }
                match result {
                    Ok(result) => {
                        json!({ "id": id, "ok": true, "result": result, "ms": started.elapsed().as_millis() as u64 })
                    }
                    Err(error) => json!({ "id": id, "ok": false, "error": format!("{error:#}") }),
                }
            }
            Err(error) => json!({ "ok": false, "error": format!("bad request: {error}") }),
        };
        writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
        stdout.flush()?;
    }
    Ok(())
}
