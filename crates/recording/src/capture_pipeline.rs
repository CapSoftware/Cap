use std::{future::Future, path::PathBuf, sync::Arc};

use cap_flags::FLAGS;
use cap_media::{
    data::{AudioInfo, FFAudio},
    encoders::{H264Encoder, MP4File, OpusEncoder},
    pipeline::{builder::PipelineBuilder, task::PipelineSourceTask, CloneInto, RealTimeClock},
    sources::{
        system_audio::{self, SystemAudioSource},
        AudioInputSource, AudioMixer, ScreenCaptureSource, ScreenCaptureTarget,
    },
    MediaError,
};

use crate::RecordingError;

pub type CapturePipelineBuilder = PipelineBuilder<RealTimeClock<()>>;

pub trait MakeCapturePipeline: std::fmt::Debug + 'static {
    fn make_capture_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        output_path: PathBuf,
    ) -> Result<CapturePipelineBuilder, MediaError>
    where
        Self: Sized;

    fn make_instant_mode_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        audio: Option<AudioInputSource>,
        capture_system_audio: bool,
        output_path: PathBuf,
    ) -> impl Future<Output = Result<CapturePipelineBuilder, MediaError>> + Send
    where
        Self: Sized;
}

#[cfg(target_os = "macos")]
impl MakeCapturePipeline for cap_media::sources::CMSampleBufferCapture {
    fn make_capture_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        output_path: PathBuf,
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

    async fn make_instant_mode_pipeline(
        mut builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        audio: Option<AudioInputSource>,
        capture_system_audio: bool,
        output_path: PathBuf,
    ) -> Result<CapturePipelineBuilder, MediaError> {
        let mut audio_mixer = AudioMixer::new();

        let system_audio = if FLAGS.system_audio_recording && capture_system_audio {
            fn create<T>(
                pipeline_builder: PipelineBuilder<RealTimeClock<()>>,
                source: T,
                audio_mixer: &mut AudioMixer,
            ) -> Result<(PipelineBuilder<RealTimeClock<()>>, AudioInfo), MediaError>
            where
                T: SystemAudioSource + PipelineSourceTask<Output = FFAudio> + 'static,
                T::Clock: Send + 'static,
                RealTimeClock<()>: CloneInto<T::Clock>,
            {
                let info = T::info().map_err(MediaError::TaskLaunch)?;
                Ok((
                    pipeline_builder
                        .source("system_audio_capture", source)
                        .sink("system_audio_sink", audio_mixer.sink(info)),
                    info,
                ))
            }

            let (new_builder, info) = create(
                builder,
                {
                    #[cfg(target_os = "macos")]
                    {
                        system_audio::macos::Source::init()
                            .await
                            .map_err(MediaError::TaskLaunch)?
                    }
                    #[cfg(windows)]
                    {
                        system_audio::windows::Source
                    }
                },
                &mut audio_mixer,
            )?;
            builder = new_builder;
            Some(info)
        } else {
            None
        };

        let mp4 = Arc::new(std::sync::Mutex::new(
            cap_media::encoders::MP4AVAssetWriterEncoder::init(
                "mp4",
                source.info(),
                system_audio,
                output_path.into(),
                Some(1080),
            )?,
        ));

        let mut builder = builder
            .source("screen_capture", source)
            .sink("screen_encoder", mp4.clone());

        if let Some(audio) = audio {
            let info = audio.info();
            builder = builder
                .source("microphone_capture", audio)
                .sink("microphone_sink", audio_mixer.sink(info));
        }

        if audio_mixer.has_sources() {
            builder = builder
                .source("audio_mixer", audio_mixer)
                .sink("audio_encoder", mp4.clone());
        }

        Ok(builder)
    }
}

impl MakeCapturePipeline for cap_media::sources::AVFrameCapture {
    fn make_capture_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        output_path: PathBuf,
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

    async fn make_instant_mode_pipeline(
        builder: CapturePipelineBuilder,
        source: ScreenCaptureSource<Self>,
        audio: Option<AudioInputSource>,
        capture_system_audio: bool,
        output_path: PathBuf,
    ) -> Result<CapturePipelineBuilder, MediaError>
    where
        Self: Sized,
    {
        let screen_config = source.info();
        let audio_info = audio.as_ref().map(|f| f.info());
        let mp4 = Arc::new(std::sync::Mutex::new(MP4File::init(
            "screen",
            output_path.into(),
            H264Encoder::factory("screen", screen_config),
            |o| audio_info.map(|a| OpusEncoder::init("mic_audio", a, o)),
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
        ScreenCaptureSource::<cap_media::sources::AVFrameCapture>::init(
            capture_target,
            None,
            show_camera,
            force_show_cursor,
            max_fps,
        )
        .map_err(|e| RecordingError::Media(MediaError::TaskLaunch(e)))
    }
}
