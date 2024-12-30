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

pub struct RecordingSegment {
    pub start: f64,
    pub end: f64,
    pub pipeline: RecordingPipeline,
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
