use std::{
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
    time::{SystemTime, UNIX_EPOCH},
};

use cap_flags::FLAGS;
use cap_media::{
    encoders::{H264Encoder, MP3Encoder, Output},
    feeds::{AudioInputFeed, CameraFeed},
    filters::VideoFilter,
    pipeline::{builder::PipelineBuilder, Pipeline, RealTimeClock},
    sources::{AudioInputSource, CameraSource, ScreenCaptureSource, ScreenCaptureTarget},
    MediaError,
};
use cap_project::{CameraMeta, CursorEvents, RecordingMeta};
use either::Either;
use thiserror::Error;
use tokio::sync::{oneshot, Mutex};

use crate::{
    cursor::{spawn_cursor_recorder, CursorActor, Cursors},
    RecordingOptions,
};

struct CursorPipeline {
    pub output_path: PathBuf,
    pub actor: CursorActor,
}

pub struct CompletedRecording {
    pub id: String,
    pub recording_dir: PathBuf,
    pub display_source: ScreenCaptureTarget,
    pub meta: RecordingMeta,
    pub cursor_data: cap_project::CursorData,
    pub segments: Vec<f64>,
}

async fn stop_recording(mut actor: Actor) -> Result<CompletedRecording, RecordingError> {
    let segment = (actor.start_time, current_time_f64());

    use cap_project::*;

    let meta = RecordingMeta {
        project_path: actor.recording_dir.clone(),
        sharing: None,
        pretty_name: format!(
            "Cap {}",
            chrono::Local::now().format("%Y-%m-%d at %H.%M.%S")
        ),
        content: Content::SingleSegment {
            segment: SingleSegment {
                display: Display {
                    path: actor
                        .pipeline
                        .display_output_path
                        .strip_prefix(&actor.recording_dir)
                        .unwrap()
                        .to_owned(),
                },
                camera: actor
                    .pipeline
                    .camera_output_path
                    .as_ref()
                    .map(|path| CameraMeta {
                        path: path.strip_prefix(&actor.recording_dir).unwrap().to_owned(),
                    }),
                audio: actor
                    .pipeline
                    .audio_output_path
                    .as_ref()
                    .map(|path| AudioMeta {
                        path: path.strip_prefix(&actor.recording_dir).unwrap().to_owned(),
                    }),
                cursor: Some(PathBuf::from("content/cursor.json")),
            },
        },
    };

    actor.pipeline.inner.shutdown().await?;

    actor
        .stop_signal
        .store(true, std::sync::atomic::Ordering::Relaxed);

    let cursor_data = if let Some(cursor) = actor.cursor {
        let resp = cursor.stop().await;
        cap_project::CursorData {
            clicks: resp.clicks,
            moves: resp.moves,
            cursor_images: CursorImages(
                resp.cursors
                    .into_values()
                    .map(|(filename, id)| (id.to_string(), filename))
                    .collect(),
            ),
        }
    } else {
        Default::default()
    };

    std::fs::write(
        actor.recording_dir.join("content/cursor.json"),
        serde_json::to_string_pretty(&cursor_data)?,
    )?;

    meta.save_for_project()
        .map_err(Either::either_into::<RecordingError>)?;

    Ok(CompletedRecording {
        id: actor.id,
        meta,
        cursor_data,
        recording_dir: actor.recording_dir,
        display_source: actor.options.capture_target,
        segments: vec![segment.0, segment.1],
    })
}

fn create_screen_capture(
    recording_options: &RecordingOptions,
) -> ScreenCaptureSource<impl MakeCapturePipeline> {
    #[cfg(target_os = "macos")]
    {
        ScreenCaptureSource::<cap_media::sources::CMSampleBufferCapture>::init(
            dbg!(&recording_options.capture_target),
            None,
            None,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        ScreenCaptureSource::<cap_media::sources::AVFrameCapture>::init(
            dbg!(&recording_options.capture_target),
            None,
            None,
        )
    }
}

struct RecordingPipeline {
    pub inner: Pipeline<RealTimeClock<()>>,
    pub display_output_path: PathBuf,
    pub audio_output_path: Option<PathBuf>,
    pub camera_output_path: Option<PathBuf>,
    pub cursor: Option<CursorPipeline>,
}

impl RecordingSegment {
    pub fn camera_meta(&self, base_path: &Path) -> Option<CameraMeta> {
        self.pipeline
            .camera_output_path
            .as_ref()
            .map(|path| CameraMeta {
                path: path.strip_prefix(base_path).unwrap().to_owned(),
            })
    }
}
