use crate::{
    CAMERA_MAX_FALLBACK_DISTANCE, DecodedSegmentFrames, DecoderStatus,
    SCREEN_MAX_FALLBACK_DISTANCE,
    decoder::{
        ManagedVideoDecoder, ManagedVideoError, ManagedVideoExit, ManagedVideoStopHandle,
        spawn_managed_decoder,
    },
    segment_timing::{SegmentVideoTiming, segment_frame_times, segment_video_timing},
};
use cap_enc_ffmpeg::RelocatableSource;
use cap_project::{ClipOffsets, StudioRecordingMeta, XY};
use std::path::{Component, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ManagedSegmentVideoError {
    #[error("Invalid managed segment input: {0}")]
    InvalidInput(String),
    #[error("Display: {0}")]
    Display(ManagedVideoError),
    #[error("Camera: {0}")]
    Camera(ManagedVideoError),
}

#[derive(Clone)]
pub struct ManagedVideoTrackInput {
    source: RelocatableSource,
    paths: Vec<PathBuf>,
}

impl ManagedVideoTrackInput {
    pub fn new(
        source: RelocatableSource,
        paths: Vec<PathBuf>,
    ) -> Result<Self, ManagedSegmentVideoError> {
        if paths.is_empty()
            || paths.iter().any(|path| {
                path.as_os_str().is_empty()
                    || !path.components().all(|part| match part {
                        Component::Normal(name) => !name.to_string_lossy().contains(['\\', ':']),
                        _ => false,
                    })
            })
        {
            return Err(ManagedSegmentVideoError::InvalidInput(
                "Track requires ordered source-relative paths".into(),
            ));
        }
        Ok(Self { source, paths })
    }
}

#[derive(Clone)]
pub struct ManagedSegmentVideoInput {
    segment_index: usize,
    timing: SegmentVideoTiming,
    display: ManagedVideoTrackInput,
    camera: Option<ManagedVideoTrackInput>,
}

impl ManagedSegmentVideoInput {
    pub fn new(
        segment_index: usize,
        metadata: &StudioRecordingMeta,
        display: ManagedVideoTrackInput,
        camera: Option<ManagedVideoTrackInput>,
    ) -> Result<Self, ManagedSegmentVideoError> {
        let timing = validated_timing(segment_index, metadata, camera.is_some())?;
        Ok(Self {
            segment_index,
            timing,
            display,
            camera,
        })
    }

    pub fn matches_metadata(&self, metadata: &StudioRecordingMeta) -> bool {
        validated_timing(self.segment_index, metadata, self.camera.is_some())
            .is_ok_and(|timing| timing == self.timing)
    }

    pub fn segment_index(&self) -> usize {
        self.segment_index
    }
}

fn validated_timing(
    segment_index: usize,
    metadata: &StudioRecordingMeta,
    has_camera: bool,
) -> Result<SegmentVideoTiming, ManagedSegmentVideoError> {
    let valid_index = match metadata {
        StudioRecordingMeta::SingleSegment { .. } => segment_index == 0,
        StudioRecordingMeta::MultipleSegments { inner, .. } => segment_index < inner.segments.len(),
    };
    if !valid_index {
        return Err(ManagedSegmentVideoError::InvalidInput(
            "Segment index is outside the stopped metadata".into(),
        ));
    }
    let timing = segment_video_timing(metadata, segment_index);
    let finite_starts = match metadata {
        StudioRecordingMeta::SingleSegment { .. } => true,
        StudioRecordingMeta::MultipleSegments { inner, .. } => {
            let segment = &inner.segments[segment_index];
            std::iter::once(segment.display.start_time)
                .chain(segment.camera.iter().map(|track| track.start_time))
                .chain(segment.mic.iter().map(|track| track.start_time))
                .chain(segment.system_audio.iter().map(|track| track.start_time))
                .all(|start| start.is_some_and(f64::is_finite))
        }
    };
    if !finite_starts
        || !timing.screen_offset.is_finite()
        || !timing.camera_offset.is_finite()
        || !timing.latest_start_time.unwrap_or(0.0).is_finite()
        || timing.screen_fps == 0
        || timing.camera_fps == Some(0)
        || has_camera != timing.camera_fps.is_some()
    {
        return Err(ManagedSegmentVideoError::InvalidInput(
            "Track layout, FPS, or start times are invalid".into(),
        ));
    }
    Ok(timing)
}

#[derive(Clone, Debug)]
pub struct ManagedSegmentDecoderStatus {
    pub segment_index: usize,
    pub display: DecoderStatus,
    pub camera: Option<DecoderStatus>,
}

#[derive(Clone, Default)]
pub struct ManagedSegmentStopHandles {
    display: Option<ManagedVideoStopHandle>,
    camera: Option<ManagedVideoStopHandle>,
}

#[derive(Clone, Debug)]
pub struct ManagedSegmentVideoExit {
    pub display: Option<ManagedVideoExit>,
    pub camera: Option<ManagedVideoExit>,
}

impl ManagedSegmentStopHandles {
    pub fn cancel(&self) {
        if let Some(display) = &self.display {
            display.cancel();
        }
        if let Some(camera) = &self.camera {
            camera.cancel();
        }
    }

    pub async fn stop_and_wait(&self) -> ManagedSegmentVideoExit {
        self.cancel();
        let (display, camera) = tokio::join!(
            async {
                match &self.display {
                    Some(display) => Some(display.stop_and_wait().await),
                    None => None,
                }
            },
            async {
                match &self.camera {
                    Some(camera) => Some(camera.stop_and_wait().await),
                    None => None,
                }
            }
        );
        ManagedSegmentVideoExit { display, camera }
    }
}

struct CancelSegmentReadiness(Option<ManagedSegmentStopHandles>);

impl Drop for CancelSegmentReadiness {
    fn drop(&mut self) {
        if let Some(handles) = &self.0 {
            handles.cancel();
        }
    }
}

pub struct ManagedRecordingSegmentDecoders {
    segment_index: usize,
    segment_offset: f64,
    display: Option<ManagedVideoDecoder>,
    camera: Option<ManagedVideoDecoder>,
    handles: ManagedSegmentStopHandles,
    terminal: std::sync::Mutex<Option<ManagedSegmentVideoError>>,
    readiness_phase: Option<crate::readiness::Phase>,
}

impl ManagedRecordingSegmentDecoders {
    #[cfg(test)]
    pub(crate) fn from_test_workers(
        display: ManagedVideoDecoder,
        camera: ManagedVideoDecoder,
    ) -> Self {
        Self {
            segment_index: 0,
            segment_offset: 0.0,
            handles: ManagedSegmentStopHandles {
                display: Some(display.stop_handle()),
                camera: Some(camera.stop_handle()),
            },
            display: Some(display),
            camera: Some(camera),
            terminal: std::sync::Mutex::new(None),
            readiness_phase: None,
        }
    }

    pub fn spawn(input: ManagedSegmentVideoInput, use_hw_acceleration: bool) -> Self {
        let readiness_phase = crate::readiness::Phase::start("managed.spawn_to_ready");
        let ManagedSegmentVideoInput {
            segment_index,
            timing,
            display,
            camera,
        } = input;
        let mut result = Self {
            segment_index,
            segment_offset: timing.latest_start_time.unwrap_or(0.0),
            display: None,
            camera: None,
            handles: ManagedSegmentStopHandles::default(),
            terminal: std::sync::Mutex::new(None),
            readiness_phase: Some(readiness_phase),
        };
        match spawn_managed_decoder(
            "screen",
            display.source,
            display.paths.iter().map(PathBuf::as_path),
            timing.screen_fps,
            timing.screen_offset,
            use_hw_acceleration,
        ) {
            Ok(decoder) => {
                result.handles.display = Some(decoder.stop_handle());
                result.display =
                    Some(decoder.with_max_fallback_distance(SCREEN_MAX_FALLBACK_DISTANCE));
            }
            Err(error) => {
                result.fail(ManagedSegmentVideoError::Display(error));
                return result;
            }
        }
        if let Some(camera) = camera {
            match spawn_managed_decoder(
                "camera",
                camera.source,
                camera.paths.iter().map(PathBuf::as_path),
                timing
                    .camera_fps
                    .expect("Managed input validates camera metadata"),
                timing.camera_offset,
                use_hw_acceleration,
            ) {
                Ok(decoder) => {
                    result.handles.camera = Some(decoder.stop_handle());
                    result.camera =
                        Some(decoder.with_max_fallback_distance(CAMERA_MAX_FALLBACK_DISTANCE));
                }
                Err(error) => {
                    result.fail(ManagedSegmentVideoError::Camera(error));
                    result.handles.cancel();
                }
            }
        }
        result
    }

    pub fn stop_handles(&self) -> ManagedSegmentStopHandles {
        self.handles.clone()
    }

    fn fail(&self, error: ManagedSegmentVideoError) -> ManagedSegmentVideoError {
        self.terminal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_or_insert(error)
            .clone()
    }

    pub fn terminal_error(&self) -> Option<ManagedSegmentVideoError> {
        if let Some(error) = self
            .terminal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
        {
            return Some(error);
        }
        self.display
            .as_ref()
            .and_then(ManagedVideoDecoder::terminal_error)
            .map(ManagedSegmentVideoError::Display)
            .or_else(|| {
                self.camera
                    .as_ref()
                    .and_then(ManagedVideoDecoder::terminal_error)
                    .map(ManagedSegmentVideoError::Camera)
            })
            .map(|error| self.fail(error))
    }

    pub async fn wait_ready(
        &mut self,
    ) -> Result<ManagedSegmentDecoderStatus, ManagedSegmentVideoError> {
        let readiness_phase = self.readiness_phase.take();
        if let Some(error) = self.terminal_error() {
            self.stop_and_wait().await;
            return Err(error);
        }
        let mut cancellation = CancelSegmentReadiness(Some(self.stop_handles()));
        let result = tokio::try_join!(
            async {
                self.display
                    .as_mut()
                    .ok_or(ManagedSegmentVideoError::Display(
                        ManagedVideoError::NotReady,
                    ))?
                    .wait_ready()
                    .await
                    .map_err(ManagedSegmentVideoError::Display)
            },
            async {
                match &mut self.camera {
                    Some(camera) => camera
                        .wait_ready()
                        .await
                        .map(Some)
                        .map_err(ManagedSegmentVideoError::Camera),
                    None => Ok(None),
                }
            }
        );
        cancellation.0 = None;
        match result {
            Ok((display, camera)) => {
                if let Some(error) = self.terminal_error() {
                    self.stop_and_wait().await;
                    return Err(error);
                }
                if let Some(phase) = readiness_phase {
                    phase.finish("ready");
                }
                Ok(ManagedSegmentDecoderStatus {
                    segment_index: self.segment_index,
                    display,
                    camera,
                })
            }
            Err(error) => {
                let error = self.fail(error);
                self.stop_and_wait().await;
                Err(error)
            }
        }
    }

    pub async fn get_frames_initial(
        &self,
        segment_time: f32,
        needs_camera: bool,
        needs_display: bool,
        offsets: ClipOffsets,
    ) -> Result<DecodedSegmentFrames, ManagedSegmentVideoError> {
        self.request_frames::<true>(segment_time, needs_camera, needs_display, offsets)
            .await
    }

    pub async fn get_frames(
        &self,
        segment_time: f32,
        needs_camera: bool,
        needs_display: bool,
        offsets: ClipOffsets,
    ) -> Result<DecodedSegmentFrames, ManagedSegmentVideoError> {
        self.request_frames::<false>(segment_time, needs_camera, needs_display, offsets)
            .await
    }

    async fn request_frames<const INITIAL: bool>(
        &self,
        segment_time: f32,
        needs_camera: bool,
        needs_display: bool,
        offsets: ClipOffsets,
    ) -> Result<DecodedSegmentFrames, ManagedSegmentVideoError> {
        if let Some(error) = self.terminal_error() {
            return Err(error);
        }
        let display = self
            .display
            .as_ref()
            .ok_or(ManagedSegmentVideoError::Display(
                ManagedVideoError::NotReady,
            ))?;
        let status = display
            .decoder_status()
            .ok_or(ManagedSegmentVideoError::Display(
                ManagedVideoError::NotReady,
            ))?;
        let (camera_time, recording_time) =
            segment_frame_times(segment_time, self.segment_offset, offsets);
        let result = tokio::try_join!(
            async {
                if !needs_display {
                    return Ok(None);
                }
                if INITIAL {
                    display.get_frame_initial(segment_time).await
                } else {
                    display.get_frame(segment_time).await
                }
                .map(Some)
                .map_err(ManagedSegmentVideoError::Display)
            },
            async {
                let Some(camera) = self.camera.as_ref().filter(|_| needs_camera) else {
                    return Ok(None);
                };
                if INITIAL {
                    camera.get_frame_initial(camera_time).await
                } else {
                    camera.get_frame(camera_time).await
                }
                .map(Some)
                .map_err(ManagedSegmentVideoError::Camera)
            }
        );
        let (screen_frame, camera_frame) = match result {
            Ok(frames) => frames,
            Err(error) => {
                let error = self.fail(error);
                self.stop_and_wait().await;
                return Err(error);
            }
        };
        if let Some(error) = self.terminal_error() {
            self.stop_and_wait().await;
            return Err(error);
        }
        Ok(DecodedSegmentFrames {
            screen_size: XY::new(status.video_width, status.video_height),
            screen_frame,
            camera_frame,
            segment_time,
            recording_time,
            segment_has_camera: self.camera.is_some(),
        })
    }

    pub async fn stop_and_wait(&self) -> ManagedSegmentVideoExit {
        self.handles.stop_and_wait().await
    }

    pub async fn wait_for_terminal(&self) -> ManagedSegmentVideoError {
        if let Some(error) = self.terminal_error() {
            return error;
        }
        match (&self.handles.display, &self.handles.camera) {
            (Some(display), Some(camera)) => {
                tokio::select! {
                    error = display.wait_for_terminal() => self.fail(ManagedSegmentVideoError::Display(error)),
                    error = camera.wait_for_terminal() => self.fail(ManagedSegmentVideoError::Camera(error)),
                }
            }
            (Some(display), None) => self.fail(ManagedSegmentVideoError::Display(
                display.wait_for_terminal().await,
            )),
            _ => self.fail(ManagedSegmentVideoError::InvalidInput(
                "Managed display worker is unavailable".into(),
            )),
        }
    }
}

impl Drop for ManagedRecordingSegmentDecoders {
    fn drop(&mut self) {
        self.handles.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> StudioRecordingMeta {
        serde_json::from_value(serde_json::json!({
            "segments": [{
                "display": {"path":"display.mp4", "fps":60, "start_time":10.0},
                "camera": {"path":"camera.mp4", "fps":24, "start_time":10.125},
                "mic": {"path":"mic.aac", "start_time":10.25}
            }]
        }))
        .unwrap()
    }

    fn track(source: &RelocatableSource) -> ManagedVideoTrackInput {
        ManagedVideoTrackInput::new(
            source.clone(),
            vec![PathBuf::from("segment-0").join("display").join("init.mp4")],
        )
        .unwrap()
    }

    #[test]
    fn owned_input_accepts_native_relative_components_without_opening_media() {
        let directory = tempfile::tempdir().unwrap();
        let source = RelocatableSource::new(directory.path().to_path_buf()).unwrap();
        let input =
            ManagedSegmentVideoInput::new(0, &metadata(), track(&source), Some(track(&source)))
                .unwrap();
        assert_eq!(input.segment_index(), 0);
        assert_eq!(input.timing.screen_offset, 0.25);
        assert_eq!(input.timing.camera_offset, 0.125);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        for paths in [
            Vec::new(),
            vec![PathBuf::new()],
            vec![PathBuf::from("../init.mp4")],
            vec![directory.path().join("init.mp4")],
            vec![PathBuf::from("D:init.mp4")],
        ] {
            assert!(ManagedVideoTrackInput::new(source.clone(), paths).is_err());
        }
    }

    #[test]
    fn managed_input_declines_bad_index_camera_layout_and_nonfinite_starts() {
        let directory = tempfile::tempdir().unwrap();
        let source = RelocatableSource::new(directory.path().to_path_buf()).unwrap();
        assert!(
            ManagedSegmentVideoInput::new(1, &metadata(), track(&source), Some(track(&source)))
                .is_err()
        );
        assert!(ManagedSegmentVideoInput::new(0, &metadata(), track(&source), None).is_err());
        let mut metadata = metadata();
        let StudioRecordingMeta::MultipleSegments { inner } = &mut metadata else {
            panic!("Expected multi-segment metadata");
        };
        inner.segments[0].mic.as_mut().unwrap().start_time = Some(f64::NAN);
        assert!(
            ManagedSegmentVideoInput::new(0, &metadata, track(&source), Some(track(&source)))
                .is_err()
        );
        let StudioRecordingMeta::MultipleSegments { inner } = &mut metadata else {
            panic!("Expected multi-segment metadata");
        };
        inner.segments[0].mic.as_mut().unwrap().start_time = Some(10.25);
        inner.segments[0].camera.as_mut().unwrap().fps = 0;
        assert!(
            ManagedSegmentVideoInput::new(0, &metadata, track(&source), Some(track(&source)))
                .is_err()
        );
    }

    #[test]
    fn managed_input_requires_start_times_for_every_declared_track() {
        let directory = tempfile::tempdir().unwrap();
        let source = RelocatableSource::new(directory.path().to_path_buf()).unwrap();
        for missing in 0..4 {
            let mut metadata = metadata();
            let StudioRecordingMeta::MultipleSegments { inner } = &mut metadata else {
                panic!("Expected multi-segment metadata");
            };
            let segment = &mut inner.segments[0];
            segment.system_audio = segment.mic.clone();
            let starts = [
                &mut segment.display.start_time,
                &mut segment.camera.as_mut().unwrap().start_time,
                &mut segment.mic.as_mut().unwrap().start_time,
                &mut segment.system_audio.as_mut().unwrap().start_time,
            ];
            *starts.into_iter().nth(missing).unwrap() = None;
            assert!(
                ManagedSegmentVideoInput::new(0, &metadata, track(&source), Some(track(&source)))
                    .is_err()
            );
        }
    }
}
