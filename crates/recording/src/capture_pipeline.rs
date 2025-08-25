use cap_media::MediaError;

use cap_media_info::AudioInfo;
use flume::{Receiver, Sender};
use std::{
    future::Future,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::SystemTime,
};

use crate::{
    RecordingError,
    feeds::microphone::MicrophoneFeedLock,
    pipeline::builder::PipelineBuilder,
    sources::{
        AudioInputSource, AudioMixer, ScreenCaptureFormat, ScreenCaptureSource,
        ScreenCaptureTarget, screen_capture,
    },
};

pub trait MakeCapturePipeline: ScreenCaptureFormat + std::fmt::Debug + 'static {
    fn make_studio_mode_pipeline(
        builder: PipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<(Self::VideoFormat, f64)>,
        ),
        output_path: PathBuf,
    ) -> Result<(PipelineBuilder, flume::Receiver<f64>), MediaError>
    where
        Self: Sized;

    fn make_instant_mode_pipeline(
        builder: PipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<(Self::VideoFormat, f64)>,
        ),
        audio: Option<Arc<MicrophoneFeedLock>>,
        system_audio: Option<(Receiver<(ffmpeg::frame::Audio, f64)>, AudioInfo)>,
        output_path: PathBuf,
        pause_flag: Arc<AtomicBool>,
    ) -> impl Future<Output = Result<PipelineBuilder, MediaError>> + Send
    where
        Self: Sized;
}

#[cfg(target_os = "macos")]
impl MakeCapturePipeline for screen_capture::CMSampleBufferCapture {
    fn make_studio_mode_pipeline(
        mut builder: PipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<(Self::VideoFormat, f64)>,
        ),
        output_path: PathBuf,
    ) -> Result<(PipelineBuilder, flume::Receiver<f64>), MediaError> {
        let screen_config = source.0.info();
        tracing::info!("screen config: {:?}", screen_config);

        let mut screen_encoder = cap_media_encoders::MP4AVAssetWriterEncoder::init(
            "screen",
            screen_config,
            None,
            output_path,
            None,
        )
        .map_err(|e| MediaError::Any(e.to_string().into()))?;

        let (timestamp_tx, timestamp_rx) = flume::bounded(1);

        builder.spawn_source("screen_capture", source.0);

        builder.spawn_task("screen_capture_encoder", move |ready| {
            let mut timestamp_tx = Some(timestamp_tx);
            let _ = ready.send(Ok(()));

            let Ok(frame) = source.1.recv() else {
                return Ok(());
            };

            if let Some(timestamp_tx) = timestamp_tx.take() {
                let _ = timestamp_tx.send(frame.1);
            }

            let result = loop {
                match source.1.recv() {
                    Ok(frame) => {
                        let _ = screen_encoder.queue_video_frame(frame.0.as_ref());
                    }
                    // Err(RecvTimeoutError::Timeout) => {
                    //     break Err("Frame receive timeout".to_string());
                    // }
                    Err(_) => {
                        break Ok(());
                    }
                }
            };

            screen_encoder.finish();

            result
        });

        Ok((builder, timestamp_rx))
    }

    async fn make_instant_mode_pipeline(
        mut builder: PipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<(Self::VideoFormat, f64)>,
        ),
        audio: Option<Arc<MicrophoneFeedLock>>,
        system_audio: Option<(Receiver<(ffmpeg::frame::Audio, f64)>, AudioInfo)>,
        output_path: PathBuf,
        pause_flag: Arc<AtomicBool>,
    ) -> Result<PipelineBuilder, MediaError> {
        let (audio_tx, audio_rx) = flume::bounded(64);
        let mut audio_mixer = AudioMixer::new(audio_tx);

        if let Some(system_audio) = system_audio {
            audio_mixer.add_source(system_audio.1, system_audio.0);
        }

        if let Some(audio) = audio {
            let sink = audio_mixer.sink(*audio.audio_info());
            let source = AudioInputSource::init(audio, sink.tx, SystemTime::now());

            builder.spawn_source("microphone_capture", source);
        }

        let has_audio_sources = audio_mixer.has_sources();

        let mp4 = Arc::new(std::sync::Mutex::new(
            cap_media_encoders::MP4AVAssetWriterEncoder::init(
                "mp4",
                source.0.info(),
                has_audio_sources.then_some(AudioMixer::info()),
                output_path,
                Some(1080),
            )
            .map_err(|e| MediaError::Any(e.to_string().into()))?,
        ));

        use cidre::cm;
        use ffmpeg::ffi::AV_TIME_BASE_Q;
        use tracing::error;

        let (first_frame_tx, mut first_frame_rx) =
            tokio::sync::oneshot::channel::<(cm::Time, f64)>();

        if has_audio_sources {
            builder.spawn_source("audio_mixer", audio_mixer);

            let mp4 = mp4.clone();
            builder.spawn_task("audio_encoding", move |ready| {
                let _ = ready.send(Ok(()));
                let mut time = None;

                while let Ok(mut frame) = audio_rx.recv() {
                    let pts = frame.pts().unwrap();

                    if let Ok(first_time) = first_frame_rx.try_recv() {
                        time = Some(first_time);
                    };

                    let Some(time) = time else {
                        continue;
                    };

                    let elapsed = (pts as f64 / AV_TIME_BASE_Q.den as f64) - time.1;

                    let time = time.0.add(cm::Time::new(
                        (elapsed * time.0.scale as f64 + time.1 * time.0.scale as f64) as i64,
                        time.0.scale,
                    ));

                    frame.set_pts(Some(time.value / (time.scale / AV_TIME_BASE_Q.den) as i64));

                    if let Ok(mut mp4) = mp4.lock()
                        && let Err(e) = mp4.queue_audio_frame(frame)
                    {
                        error!("{e}");
                        return Ok(());
                    }
                }

                Ok(())
            });
        }

        let mut first_frame_tx = Some(first_frame_tx);
        builder.spawn_task("screen_capture_encoder", move |ready| {
            let _ = ready.send(Ok(()));
            while let Ok((frame, unix_time)) = source.1.recv() {
                if let Ok(mut mp4) = mp4.lock() {
                    if pause_flag.load(std::sync::atomic::Ordering::Relaxed) {
                        mp4.pause();
                    } else {
                        mp4.resume();
                    }

                    if let Some(first_frame_tx) = first_frame_tx.take() {
                        let _ = first_frame_tx.send((frame.pts(), unix_time));
                    }

                    mp4.queue_video_frame(frame.as_ref())
                        .map_err(|err| error!("Error queueing video frame: {err}"))
                        .ok();
                }
            }
            if let Ok(mut mp4) = mp4.lock() {
                mp4.finish();
            }

            Ok(())
        });

        builder.spawn_source("screen_capture", source.0);

        Ok(builder)
    }
}

#[cfg(windows)]
impl MakeCapturePipeline for screen_capture::AVFrameCapture {
    fn make_studio_mode_pipeline(
        mut builder: PipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<(Self::VideoFormat, f64)>,
        ),
        output_path: PathBuf,
    ) -> Result<(PipelineBuilder, flume::Receiver<f64>), MediaError>
    where
        Self: Sized,
    {
        use cap_media_encoders::{H264Encoder, MP4File};

        let screen_config = source.0.info();
        let mut screen_encoder = MP4File::init(
            "screen",
            output_path,
            |o| H264Encoder::builder("screen", dbg!(screen_config)).build(o),
            |_| None,
        )
        .map_err(|e| MediaError::Any(e.to_string().into()))?;

        builder.spawn_source("screen_capture", source.0);

        let (timestamp_tx, timestamp_rx) = flume::bounded(1);

        builder.spawn_task("screen_capture_encoder", move |ready| {
            let mut timestamp_tx = Some(timestamp_tx);
            let _ = ready.send(Ok(()));

            while let Ok(frame) = source.1.recv() {
                if let Some(timestamp_tx) = timestamp_tx.take() {
                    timestamp_tx.send(frame.1).unwrap();
                }
                // dbg!(frame.1);
                screen_encoder.queue_video_frame(frame.0);
            }
            screen_encoder.finish();
            Ok(())
        });

        Ok((builder, timestamp_rx))
    }

    async fn make_instant_mode_pipeline(
        mut builder: PipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<(Self::VideoFormat, f64)>,
        ),
        audio: Option<Arc<MicrophoneFeedLock>>,
        system_audio: Option<(Receiver<(ffmpeg::frame::Audio, f64)>, AudioInfo)>,
        output_path: PathBuf,
        _pause_flag: Arc<AtomicBool>,
    ) -> Result<PipelineBuilder, MediaError>
    where
        Self: Sized,
    {
        use cap_media_encoders::{AACEncoder, AudioEncoder, H264Encoder, MP4File};

        let (audio_tx, audio_rx) = flume::bounded(64);
        let mut audio_mixer = AudioMixer::new(audio_tx);

        if let Some(system_audio) = system_audio {
            audio_mixer.add_source(system_audio.1, system_audio.0);
        }

        if let Some(audio) = audio {
            let sink = audio_mixer.sink(*audio.audio_info());
            let source = AudioInputSource::init(audio, sink.tx, SystemTime::now());

            builder.spawn_source("microphone_capture", source);
        }

        let has_audio_sources = audio_mixer.has_sources();

        let screen_config = source.0.info();
        let mp4 = Arc::new(std::sync::Mutex::new(
            MP4File::init(
                "screen",
                output_path,
                |o| H264Encoder::builder("screen", screen_config).build(o),
                |o| {
                    has_audio_sources.then(|| {
                        AACEncoder::init("mic_audio", AudioMixer::info(), o)
                            .map(|v| v.boxed())
                            .map_err(Into::into)
                    })
                },
            )
            .map_err(|e| MediaError::Any(e.to_string().into()))?,
        ));

        if has_audio_sources {
            builder.spawn_source("audio_mixer", audio_mixer);

            let mp4 = mp4.clone();
            builder.spawn_task("audio_encoding", move |ready| {
                let _ = ready.send(Ok(()));
                while let Ok(frame) = audio_rx.recv() {
                    if let Ok(mut mp4) = mp4.lock() {
                        mp4.queue_audio_frame(frame);
                    }
                }
                Ok(())
            });
        }

        builder.spawn_source("screen_capture", source.0);

        builder.spawn_task("screen_encoder", move |ready| {
            let _ = ready.send(Ok(()));
            while let Ok((frame, _unix_time)) = source.1.recv() {
                if let Ok(mut mp4) = mp4.lock() {
                    // if pause_flag.load(std::sync::atomic::Ordering::Relaxed) {
                    //     mp4.pause();
                    // } else {
                    //     mp4.resume();
                    // }

                    mp4.queue_video_frame(frame);
                }
            }
            if let Ok(mut mp4) = mp4.lock() {
                mp4.finish();
            }
            Ok(())
        });

        Ok(builder)
    }
}

type ScreenCaptureReturn<T> = (
    ScreenCaptureSource<T>,
    Receiver<(<T as ScreenCaptureFormat>::VideoFormat, f64)>,
);

#[cfg(target_os = "macos")]
pub type ScreenCaptureMethod = screen_capture::CMSampleBufferCapture;

#[cfg(windows)]
pub type ScreenCaptureMethod = screen_capture::AVFrameCapture;

pub async fn create_screen_capture(
    capture_target: &ScreenCaptureTarget,
    force_show_cursor: bool,
    max_fps: u32,
    audio_tx: Option<Sender<(ffmpeg::frame::Audio, f64)>>,
    start_time: SystemTime,
) -> Result<ScreenCaptureReturn<ScreenCaptureMethod>, RecordingError> {
    let (video_tx, video_rx) = flume::bounded(16);

    ScreenCaptureSource::<ScreenCaptureMethod>::init(
        capture_target,
        force_show_cursor,
        max_fps,
        video_tx,
        audio_tx,
        start_time,
        tokio::runtime::Handle::current(),
    )
    .await
    .map(|v| (v, video_rx))
    .map_err(|e| RecordingError::Media(MediaError::TaskLaunch(e.to_string())))
}
