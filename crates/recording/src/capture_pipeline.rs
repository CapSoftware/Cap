use std::{future::Future, path::PathBuf, sync::Arc};

use cap_media::{
    data::AudioInfo,
    encoders::{H264Encoder, MP4File, OpusEncoder},
    feeds::AudioInputFeed,
    pipeline::{builder::PipelineBuilder, task::PipelineSinkTask, RealTimeClock},
    sources::{
        AVFrameCapture, AudioInputSource, AudioMixer, CMSampleBufferCapture, ScreenCaptureFormat,
        ScreenCaptureSource, ScreenCaptureTarget,
    },
    MediaError,
};
use flume::{Receiver, Sender};
use tracing::error;

use crate::RecordingError;

pub type CapturePipelineBuilder = PipelineBuilder<RealTimeClock<()>>;

pub trait MakeCapturePipeline: ScreenCaptureFormat + std::fmt::Debug + 'static {
    fn make_studio_mode_pipeline(
        builder: CapturePipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<Self::VideoFormat>,
        ),
        output_path: PathBuf,
    ) -> Result<CapturePipelineBuilder, MediaError>
    where
        Self: Sized;

    fn make_instant_mode_pipeline(
        builder: CapturePipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<Self::VideoFormat>,
        ),
        audio: Option<&AudioInputFeed>,
        system_audio: Option<(Receiver<ffmpeg::frame::Audio>, AudioInfo)>,
        output_path: PathBuf,
    ) -> impl Future<Output = Result<CapturePipelineBuilder, MediaError>> + Send
    where
        Self: Sized;
}

#[cfg(target_os = "macos")]
impl MakeCapturePipeline for cap_media::sources::CMSampleBufferCapture {
    fn make_studio_mode_pipeline(
        mut builder: CapturePipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<Self::VideoFormat>,
        ),
        output_path: PathBuf,
    ) -> Result<CapturePipelineBuilder, MediaError> {
        let screen_config = source.0.info();
        let mut screen_encoder = cap_media::encoders::MP4AVAssetWriterEncoder::init(
            "screen",
            screen_config,
            None,
            output_path.into(),
            None,
        )?;

        builder.spawn_task("screen_capture_encoder", move |ready| {
            let _ = ready.send(Ok(()));
            while let Ok(frame) = source.1.recv() {
                screen_encoder.queue_video_frame(frame);
            }
            screen_encoder.finish();
        });

        builder.spawn_source("screen_capture", source.0);

        Ok(builder)
    }

    async fn make_instant_mode_pipeline(
        mut builder: CapturePipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<Self::VideoFormat>,
        ),
        audio: Option<&AudioInputFeed>,
        system_audio: Option<(Receiver<ffmpeg::frame::Audio>, AudioInfo)>,
        output_path: PathBuf,
    ) -> Result<CapturePipelineBuilder, MediaError> {
        let (audio_tx, audio_rx) = flume::bounded(64);
        let mut audio_mixer = AudioMixer::new(audio_tx);

        if let Some(system_audio) = system_audio {
            audio_mixer.add_source(system_audio.1, system_audio.0);
        }

        if let Some(audio) = audio {
            let sink = audio_mixer.sink(audio.audio_info());
            let source = AudioInputSource::init(audio, sink.tx);

            builder.spawn_source("microphone_capture", source);
        }

        let has_audio_sources = audio_mixer.has_sources();

        let mp4 = Arc::new(std::sync::Mutex::new(
            cap_media::encoders::MP4AVAssetWriterEncoder::init(
                "mp4",
                source.0.info(),
                has_audio_sources.then_some(AudioMixer::info()),
                output_path.into(),
                Some(1080),
            )?,
        ));

        if has_audio_sources {
            builder.spawn_source("audio_mixer", audio_mixer);

            let mp4 = mp4.clone();
            builder.spawn_task("audio_encoding", move |ready| {
                let _ = ready.send(Ok(()));
                while let Ok(frame) = audio_rx.recv() {
                    if let Ok(mut mp4) = mp4.lock() {
                        if let Err(e) = mp4.queue_audio_frame(frame) {
                            error!("{e}");
                            return;
                        }
                    }
                }
            });
        }

        builder.spawn_task("screen_capture_encoder", move |ready| {
            let _ = ready.send(Ok(()));
            while let Ok(frame) = source.1.recv() {
                if let Ok(mut mp4) = mp4.lock() {
                    mp4.queue_video_frame(frame);
                }
            }
            if let Ok(mut mp4) = mp4.lock() {
                mp4.finish();
            }
        });

        builder.spawn_source("screen_capture", source.0);

        Ok(builder)
    }
}

impl MakeCapturePipeline for AVFrameCapture {
    fn make_studio_mode_pipeline(
        mut builder: CapturePipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<Self::VideoFormat>,
        ),
        output_path: PathBuf,
    ) -> Result<CapturePipelineBuilder, MediaError>
    where
        Self: Sized,
    {
        let screen_config = source.0.info();
        let mut screen_encoder = MP4File::init(
            "screen",
            output_path.into(),
            H264Encoder::factory("screen", screen_config),
            |_| None,
        )?;

        builder.spawn_task("screen_capture_encoder", move |ready| {
            let _ = ready.send(Ok(()));
            while let Ok(frame) = source.1.recv() {
                screen_encoder.queue_video_frame(frame);
            }
            screen_encoder.finish();
        });

        builder.spawn_source("screen_capture", source.0);

        Ok(builder)
    }

    async fn make_instant_mode_pipeline(
        mut builder: CapturePipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<Self::VideoFormat>,
        ),
        audio: Option<&AudioInputFeed>,
        system_audio: Option<(Receiver<ffmpeg::frame::Audio>, AudioInfo)>,
        output_path: PathBuf,
    ) -> Result<CapturePipelineBuilder, MediaError>
    where
        Self: Sized,
    {
        let (audio_tx, audio_rx) = flume::bounded(64);
        let mut audio_mixer = AudioMixer::new(audio_tx);

        if let Some(system_audio) = system_audio {
            audio_mixer.add_source(system_audio.1, system_audio.0);
        }

        if let Some(audio) = audio {
            let sink = audio_mixer.sink(audio.audio_info());
            let source = AudioInputSource::init(audio, sink.tx);

            builder.spawn_source("microphone_capture", source);
        }

        let has_audio_sources = audio_mixer.has_sources();

        let screen_config = source.0.info();
        let mp4 = Arc::new(std::sync::Mutex::new(MP4File::init(
            "screen",
            output_path.into(),
            H264Encoder::factory("screen", screen_config),
            |o| has_audio_sources.then(|| OpusEncoder::init("mic_audio", AudioMixer::info(), o)),
        )?));

        if has_audio_sources {
            builder.spawn_source("audio_mixer", audio_mixer);

            let mp4 = mp4.clone();
            builder.spawn_task("audio_encoding", move |ready| {
                let _ = ready.send(Ok(()));
                while let Ok(frame) = audio_rx.recv() {
                    if let Ok(mut mp4) = mp4.lock() {
                        mp4.queue_audio_frame(frame)
                    }
                }
            });
        }

        builder.spawn_task("screen_encoder", move |ready| {
            let _ = ready.send(Ok(()));
            while let Ok(frame) = source.1.recv() {
                if let Ok(mut mp4) = mp4.lock() {
                    mp4.queue_video_frame(frame);
                }
            }
            if let Ok(mut mp4) = mp4.lock() {
                mp4.finish();
            }
        });

        Ok(builder)
    }
}

type ScreenCaptureReturn<T> = (
    ScreenCaptureSource<T>,
    Receiver<<T as ScreenCaptureFormat>::VideoFormat>,
);

#[cfg(target_os = "macos")]
pub type ScreenCaptureMethod = CMSampleBufferCapture;

#[cfg(not(target_os = "macos"))]
pub type ScreenCaptureMethod = AVFrameCapture;

pub fn create_screen_capture(
    capture_target: &ScreenCaptureTarget,
    show_camera: bool,
    force_show_cursor: bool,
    max_fps: u32,
    audio_tx: Option<Sender<ffmpeg::frame::Audio>>,
) -> Result<ScreenCaptureReturn<ScreenCaptureMethod>, RecordingError> {
    let (video_tx, video_rx) = flume::bounded(16);

    #[cfg(target_os = "macos")]
    {
        ScreenCaptureSource::<cap_media::sources::CMSampleBufferCapture>::init(
            capture_target,
            None,
            show_camera,
            force_show_cursor,
            max_fps,
            video_tx,
            audio_tx,
        )
        .map(|v| (v, video_rx))
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
            video_tx,
            audio_tx,
        )
        .map(|v| (v, video_rx))
        .map_err(|e| RecordingError::Media(MediaError::TaskLaunch(e)))
    }
}
