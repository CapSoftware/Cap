use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use tauri::{Listener, Manager};
use tokio::sync::RwLock;

pub const SCRIPT: &str = include_str!("stop-editor-benchmark.js");
pub const DOM_SCRIPT: &str = include_str!("stop-editor-parity-dom.js");
static FRAME_CAPTURE: OnceLock<Mutex<FrameCapture>> = OnceLock::new();
static STARTED: AtomicBool = AtomicBool::new(false);

pub fn enabled() -> bool {
    std::env::var_os("CAP_STOP_EDITOR_BENCHMARK_OUTPUT").is_some()
}

pub fn run(app: tauri::AppHandle) {
    let Some(output) = std::env::var_os("CAP_STOP_EDITOR_BENCHMARK_OUTPUT") else {
        return;
    };
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        let result = measure(&app).await;
        let mut value = match result {
            Ok(value) => value,
            Err(error) => serde_json::json!({ "error": error }),
        };
        match finish_frame_capture() {
            Ok(Some(capture)) => value["frameCapture"] = capture,
            Ok(None) => {}
            Err(error) => {
                value["frameCapture"] =
                    serde_json::json!({ "status": "incomplete", "error": error })
            }
        }
        if let Err(error) = std::fs::write(output, value.to_string()) {
            tracing::error!(%error, "Could not write Stop benchmark results");
        }
    });
}

async fn measure(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    tokio::time::sleep(Duration::from_secs(3)).await;
    let state = app.state::<Arc<RwLock<crate::App>>>();
    crate::set_mic_input(
        app.clone(),
        state.clone(),
        std::env::var("CAP_STOP_BENCH_MIC").ok(),
    )
    .await?;
    let capture_target = benchmark_capture_target()?;
    let action = crate::recording::start_recording(
        app.clone(),
        state.clone(),
        crate::recording::StartRecordingInputs {
            capture_target,
            capture_system_audio: std::env::var_os("CAP_STOP_BENCH_SYSTEM_AUDIO").is_some(),
            mode: cap_recording::RecordingMode::Studio,
            organization_id: None,
        },
    )
    .await?;
    if !matches!(action, crate::recording::RecordingAction::Started) {
        return Err("Benchmark recording did not start".into());
    }
    let seconds = std::env::var("CAP_STOP_BENCH_SECONDS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(15);
    tokio::time::sleep(Duration::from_secs(seconds)).await;
    let project = state
        .read()
        .await
        .current_recording()
        .map(|recording| recording.recording_dir().clone());
    if let Err(error) = arm_frame_capture(app, project.as_deref()) {
        let cleanup = crate::recording::stop_recording(app.clone(), state.clone()).await;
        return Err(match cleanup {
            Ok(()) => error,
            Err(cleanup_error) => format!("{error}; recording stop also failed: {cleanup_error}"),
        });
    }
    let dom_capture = DomCapture::start(app);
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let listener = app.listen_any("cap-stop-benchmark-frame", move |_| {
        let _ = sender.send(Instant::now());
    });
    let started = Instant::now();
    tracing::info!("Stop editor benchmark stop requested");
    let stopped = crate::recording::stop_recording(app.clone(), state).await;
    let stop_ms = started.elapsed().as_secs_f64() * 1000.0;
    if let Err(error) = stopped {
        app.unlisten(listener);
        return Err(error);
    }
    let frame = tokio::time::timeout(Duration::from_secs(180), receiver.recv()).await;
    app.unlisten(listener);
    let frame = frame
        .map_err(|error| error.to_string())?
        .ok_or("Editor frame channel closed")?;
    let mut result = serde_json::json!({
        "project": project,
        "recordingSeconds": seconds,
        "stopCommandMs": stop_ms,
        "editorFrameMs": frame.saturating_duration_since(started).as_secs_f64() * 1000.0,
    });
    if let Some(dom_capture) = dom_capture {
        result["domObservations"] = dom_capture.finish().await;
    }
    Ok(result)
}

fn benchmark_capture_target() -> Result<cap_recording::screen_capture::ScreenCaptureTarget, String>
{
    use cap_recording::screen_capture::ScreenCaptureTarget;
    if std::env::var_os("CAP_STOP_BENCH_FIXTURE_WINDOW").is_none() {
        return Ok(ScreenCaptureTarget::Display {
            id: scap_targets::Display::primary().id(),
        });
    }
    let window = select_exact_fixture(
        scap_targets::Window::list()
            .into_iter()
            .map(|window| (window, window.name())),
    )?;
    Ok(ScreenCaptureTarget::Window { id: window.id() })
}

fn select_exact_fixture<T>(
    windows: impl Iterator<Item = (T, Option<String>)>,
) -> Result<T, String> {
    let mut matching =
        windows.filter(|(_, name)| name.as_deref() == Some("Cap Stop benchmark fixture"));
    let window = matching
        .next()
        .ok_or("Exact benchmark fixture window is absent")?
        .0;
    if matching.next().is_some() {
        return Err("Exact benchmark fixture window is ambiguous".into());
    }
    Ok(window)
}

pub fn frame_capture_requested() -> bool {
    enabled() && std::env::var_os("CAP_STOP_BENCH_FRAME_DIR").is_some()
}

pub fn dom_capture_requested() -> bool {
    enabled() && std::env::var_os("CAP_STOP_BENCH_DOM_CAPTURE").is_some()
}

#[derive(Clone, Copy)]
pub enum CaptureKind {
    Preparing,
    Ordinary,
}

struct CapturedFrame {
    data: Arc<Vec<u8>>,
    width: u32,
    height: u32,
    stride: u32,
    frame_number: u32,
    target_time_ns: u64,
}

struct FrameCapture {
    directory: PathBuf,
    project: PathBuf,
    preparing: Option<CapturedFrame>,
    ordinary: Option<CapturedFrame>,
    closed: bool,
}

impl FrameCapture {
    fn record(&mut self, kind: CaptureKind, project: &Path, frame: CapturedFrame) {
        if self.closed || self.project != project {
            return;
        }
        let slot = match kind {
            CaptureKind::Preparing => &mut self.preparing,
            CaptureKind::Ordinary => &mut self.ordinary,
        };
        if slot.is_none() {
            *slot = Some(frame);
        }
    }
}

fn arm_frame_capture(app: &tauri::AppHandle, project: Option<&Path>) -> Result<(), String> {
    let Some(directory) = std::env::var_os("CAP_STOP_BENCH_FRAME_DIR") else {
        return Ok(());
    };
    if !app
        .config()
        .identifier
        .starts_with("so.cap.desktop.stop-editor-benchmark.")
    {
        return Err("Frame capture requires a private benchmark app identifier".into());
    }
    let directory = PathBuf::from(directory);
    if !directory.is_absolute() {
        return Err("Frame capture directory must be absolute".into());
    }
    let project = project
        .ok_or("Frame capture has no active recording project")?
        .to_path_buf();
    std::fs::create_dir(&directory).map_err(|error| error.to_string())?;
    FRAME_CAPTURE
        .set(Mutex::new(FrameCapture {
            directory,
            project,
            preparing: None,
            ordinary: None,
            closed: false,
        }))
        .map_err(|_| "Frame capture was already armed".to_string())
}

pub fn capture_output(kind: CaptureKind, project: &Path, output: &cap_editor::EditorFrameOutput) {
    let Some(capture) = FRAME_CAPTURE.get() else {
        return;
    };
    let cap_editor::EditorFrameOutput::Rgba(frame) = output else {
        return;
    };
    capture
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .record(
            kind,
            project,
            CapturedFrame {
                data: frame.data.clone(),
                width: frame.width,
                height: frame.height,
                stride: frame.padded_bytes_per_row,
                frame_number: frame.frame_number,
                target_time_ns: frame.target_time_ns,
            },
        );
}

pub fn capture_ws_frame(kind: CaptureKind, project: &Path, frame: &crate::frame_ws::WSFrame) {
    let Some(capture) = FRAME_CAPTURE.get() else {
        return;
    };
    if frame.format != crate::frame_ws::WSFrameFormat::Rgba {
        return;
    }
    capture
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .record(
            kind,
            project,
            CapturedFrame {
                data: frame.data.clone(),
                width: frame.width,
                height: frame.height,
                stride: frame.stride,
                frame_number: frame.frame_number,
                target_time_ns: frame.target_time_ns,
            },
        );
}

fn write_captured_frame(
    directory: &Path,
    name: &str,
    frame: CapturedFrame,
) -> Result<serde_json::Value, String> {
    let row_bytes = frame
        .width
        .checked_mul(4)
        .ok_or("Captured frame row overflow")?;
    let expected_bytes = (frame.stride as usize)
        .checked_mul(frame.height as usize)
        .ok_or("Captured frame length overflow")?;
    if frame.width == 0
        || frame.height == 0
        || frame.stride < row_bytes
        || frame.data.len() != expected_bytes
    {
        return Err("Captured frame has an incomplete RGBA buffer".into());
    }
    let file = directory.join(format!("{name}.rgba"));
    std::fs::write(&file, frame.data.as_slice()).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "file": file,
        "format": "rgba",
        "width": frame.width,
        "height": frame.height,
        "stride": frame.stride,
        "frameNumber": frame.frame_number,
        "targetTimeNs": frame.target_time_ns,
        "bytes": expected_bytes,
    }))
}

fn finish_frame_capture() -> Result<Option<serde_json::Value>, String> {
    let Some(capture) = FRAME_CAPTURE.get() else {
        return Ok(None);
    };
    let (directory, project, preparing, ordinary) = {
        let mut capture = capture
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        capture.closed = true;
        (
            capture.directory.clone(),
            capture.project.clone(),
            capture.preparing.take(),
            capture.ordinary.take(),
        )
    };
    let mut frames = serde_json::Map::new();
    for (name, frame) in [("preparing", preparing), ("ordinary", ordinary)] {
        if let Some(frame) = frame {
            let _ = frames.insert(
                name.to_string(),
                write_captured_frame(&directory, name, frame)?,
            );
        }
    }
    let value = serde_json::json!({
        "status": if frames.len() == 2 { "captured_uncompared" } else { "incomplete" },
        "project": project,
        "frames": frames,
        "timingQualification": "Separate untimed parity capture; renderer callback bytes are not external compositor proof",
    });
    std::fs::write(directory.join("frames.json"), value.to_string())
        .map_err(|error| error.to_string())?;
    Ok(Some(value))
}

struct DomCapture {
    app: tauri::AppHandle,
    listener: tauri::EventId,
    observations: Arc<Mutex<Vec<serde_json::Value>>>,
}

impl DomCapture {
    fn start(app: &tauri::AppHandle) -> Option<Self> {
        if !dom_capture_requested() {
            return None;
        }
        let observations = Arc::new(Mutex::new(Vec::new()));
        let captured = observations.clone();
        let listener = app.listen_any("cap-stop-benchmark-dom", move |event| {
            if let Ok(value) = serde_json::from_str(event.payload()) {
                let mut observations = captured
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if observations.len() < 1024 {
                    observations.push(value);
                }
            }
        });
        Some(Self {
            app: app.clone(),
            listener,
            observations,
        })
    }

    async fn finish(self) -> serde_json::Value {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let observations = self
            .observations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        serde_json::json!(observations)
    }
}

impl Drop for DomCapture {
    fn drop(&mut self) {
        self.app.unlisten(self.listener);
    }
}

#[cfg(test)]
mod parity_capture_tests {
    use super::*;

    fn frame(value: u8) -> CapturedFrame {
        CapturedFrame {
            data: Arc::new(vec![value; 8]),
            width: 2,
            height: 1,
            stride: 8,
            frame_number: 0,
            target_time_ns: 0,
        }
    }

    #[test]
    fn exact_fixture_selection_rejects_missing_and_ambiguous_titles() {
        assert!(select_exact_fixture(std::iter::empty::<(u8, Option<String>)>()).is_err());
        assert_eq!(
            select_exact_fixture(
                [
                    (1, Some("Cap Stop benchmark fixture".into())),
                    (2, Some("Cap Stop benchmark fixture extra".into()))
                ]
                .into_iter()
            )
            .unwrap(),
            1
        );
        assert!(
            select_exact_fixture(
                [
                    (1, Some("Cap Stop benchmark fixture".into())),
                    (2, Some("Cap Stop benchmark fixture".into()))
                ]
                .into_iter()
            )
            .is_err()
        );
    }

    #[test]
    fn first_frames_are_bound_to_project_and_capture_closure() {
        let project = PathBuf::from("owned.cap");
        let mut capture = FrameCapture {
            directory: PathBuf::new(),
            project: project.clone(),
            preparing: None,
            ordinary: None,
            closed: false,
        };
        capture.record(CaptureKind::Preparing, Path::new("other.cap"), frame(1));
        assert!(capture.preparing.is_none());
        capture.record(CaptureKind::Preparing, &project, frame(2));
        capture.record(CaptureKind::Preparing, &project, frame(3));
        capture.record(CaptureKind::Ordinary, &project, frame(4));
        assert_eq!(capture.preparing.as_ref().unwrap().data.as_slice(), &[2; 8]);
        assert_eq!(capture.ordinary.as_ref().unwrap().data.as_slice(), &[4; 8]);
        capture.closed = true;
        capture.ordinary = None;
        capture.record(CaptureKind::Ordinary, &project, frame(5));
        assert!(capture.ordinary.is_none());
    }

    #[test]
    fn rgba_capture_rejects_truncation_and_preserves_full_padded_rows() {
        let directory = tempfile::tempdir().unwrap();
        let mut truncated = frame(1);
        truncated.data = Arc::new(vec![1; 7]);
        assert!(write_captured_frame(directory.path(), "truncated", truncated).is_err());
        assert!(!directory.path().join("truncated.rgba").exists());
        let mut padded = frame(2);
        padded.stride = 12;
        padded.data = Arc::new(vec![2; 12]);
        let metadata = write_captured_frame(directory.path(), "padded", padded).unwrap();
        assert_eq!(metadata["bytes"], 12);
        assert_eq!(
            std::fs::read(directory.path().join("padded.rgba")).unwrap(),
            vec![2; 12]
        );
    }
}
