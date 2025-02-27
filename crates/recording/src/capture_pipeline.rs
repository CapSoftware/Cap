use std::{path::PathBuf, sync::Arc};

use cap_media::{
    encoders::{H264Encoder, MP4AVAssetWriterEncoder, MP4File},
    pipeline::{builder::PipelineBuilder, RealTimeClock},
    sources::{AudioInputSource, ScreenCaptureSource, ScreenCaptureTarget},
    MediaError,
};

use crate::RecordingError;

pub type CapturePipelineBuilder = PipelineBuilder<RealTimeClock<()>>;

pub trait MakeCapturePipeline: std::fmt::Debug + 'static {
    fn make_capture_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        output_path: impl Into<PathBuf>,
    ) -> Result<CapturePipelineBuilder, MediaError>
    where
        Self: Sized;

    fn make_instant_mode_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        audio: Option<AudioInputSource>,
        output_path: impl Into<PathBuf>,
    ) -> Result<CapturePipelineBuilder, MediaError>
    where
        Self: Sized;
}

#[cfg(target_os = "macos")]
impl MakeCapturePipeline for cap_media::sources::CMSampleBufferCapture {
    fn make_capture_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        output_path: impl Into<PathBuf>,
    ) -> Result<CapturePipelineBuilder, MediaError> {
        let screen_config = source.info();
        let screen_encoder = cap_media::encoders::MP4AVAssetWriterEncoder::init(
            "screen",
            screen_config,
            None,
            output_path.into(),
            None,
        )?;

        Ok(builder
            .source("screen_capture", source)
            .sink("screen_capture_encoder", screen_encoder))
    }

    fn make_instant_mode_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        audio: Option<AudioInputSource>,
        output_path: impl Into<PathBuf>,
    ) -> Result<CapturePipelineBuilder, MediaError> {
        let mp4 = Arc::new(std::sync::Mutex::new(MP4AVAssetWriterEncoder::init(
            "mp4",
            source.info(),
            audio.as_ref().map(|f| f.info()),
            output_path.into(),
            Some(1080),
        )?));

        let mut builder = builder
            .source("screen_capture", source)
            .sink("screen_encoder", mp4.clone());

        if let Some(audio) = audio {
            builder = builder
                .source("microphone_capture", audio)
                .sink("mic_encoder", mp4.clone());
        }

        Ok(builder)
    }
}

impl MakeCapturePipeline for cap_media::sources::AVFrameCapture {
    fn make_capture_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        output_path: impl Into<PathBuf>,
    ) -> Result<CapturePipelineBuilder, MediaError>
    where
        Self: Sized,
    {
        let screen_config = source.info();
        let screen_encoder = MP4File::init(
            "screen",
            output_path.into(),
            H264Encoder::factory("screen", screen_config),
            |_| None,
        )?;
        Ok(builder
            .source("screen_capture", source)
            .sink("screen_capture_encoder", screen_encoder))
    }

    fn make_instant_mode_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        audio: Option<AudioInputSource>,
        output_path: impl Into<PathBuf>,
    ) -> Result<CapturePipelineBuilder, MediaError>
    where
        Self: Sized,
    {
        todo!()
    }
}

pub fn create_screen_capture(
    capture_target: &ScreenCaptureTarget,
    show_camera: bool,
    force_show_cursor: bool,
    max_fps: u32,
) -> Result<ScreenCaptureSource<impl MakeCapturePipeline>, RecordingError> {
    #[cfg(target_os = "macos")]
    {
        ScreenCaptureSource::<cap_media::sources::CMSampleBufferCapture>::init(
            capture_target,
            None,
            show_camera,
            force_show_cursor,
            max_fps,
        )
        .map_err(|e| RecordingError::Media(MediaError::TaskLaunch(e)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        ScreenCaptureSource::<cap_media::sources::AVFrameCapture>::init(capture_target, None)
    }
}
