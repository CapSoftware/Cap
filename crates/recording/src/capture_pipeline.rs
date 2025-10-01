use crate::{
    RecordingError,
    feeds::microphone::MicrophoneFeedLock,
    pipeline::builder::PipelineBuilder,
    sources::{
        AudioInputSource, ScreenCaptureFormat, ScreenCaptureSource, ScreenCaptureTarget,
        audio_mixer::AudioMixer, screen_capture,
    },
};
use cap_media::MediaError;
use cap_media_info::AudioInfo;
use cap_timestamp::{Timestamp, Timestamps};
use flume::{Receiver, Sender};
use std::{
    future::Future,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::SystemTime,
};

pub trait MakeCapturePipeline: ScreenCaptureFormat + std::fmt::Debug + 'static {
    fn make_studio_mode_pipeline(
        builder: PipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<(Self::VideoFormat, Timestamp)>,
        ),
        output_path: PathBuf,
        start_time: Timestamps,
    ) -> Result<(PipelineBuilder, flume::Receiver<Timestamp>), MediaError>
    where
        Self: Sized;

    fn make_instant_mode_pipeline(
        builder: PipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<(Self::VideoFormat, Timestamp)>,
        ),
        audio: Option<Arc<MicrophoneFeedLock>>,
        system_audio: Option<(Receiver<(ffmpeg::frame::Audio, Timestamp)>, AudioInfo)>,
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
            flume::Receiver<(Self::VideoFormat, Timestamp)>,
        ),
        output_path: PathBuf,
        _start_time: Timestamps,
    ) -> Result<(PipelineBuilder, flume::Receiver<Timestamp>), MediaError> {
        let screen_config = source.0.info();
        tracing::info!("screen config: {:?}", screen_config);

        let mut screen_encoder = cap_enc_avfoundation::MP4Encoder::init(
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

            let Ok((frame, timestamp)) = source.1.recv() else {
                return Ok(());
            };

            if let Some(timestamp_tx) = timestamp_tx.take() {
                let _ = timestamp_tx.send(timestamp);
                let _ = screen_encoder.queue_video_frame(frame.as_ref());
            }

            let result = loop {
                match source.1.recv() {
                    Ok((frame, _)) => {
                        let _ = screen_encoder.queue_video_frame(frame.as_ref());
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
            flume::Receiver<(Self::VideoFormat, Timestamp)>,
        ),
        audio: Option<Arc<MicrophoneFeedLock>>,
        system_audio: Option<(Receiver<(ffmpeg::frame::Audio, Timestamp)>, AudioInfo)>,
        output_path: PathBuf,
        pause_flag: Arc<AtomicBool>,
    ) -> Result<PipelineBuilder, MediaError> {
        let start_time = Timestamps::now();

        let (audio_tx, audio_rx) = flume::bounded(64);
        let mut audio_mixer = AudioMixer::builder(audio_tx);

        if let Some(system_audio) = system_audio {
            audio_mixer.add_source(system_audio.1, system_audio.0);
        }

        if let Some(audio) = audio {
            let (tx, rx) = flume::bounded(32);
            audio_mixer.add_source(*audio.audio_info(), rx);
            let source = AudioInputSource::init(audio, tx);

            builder.spawn_source("microphone_capture", source);
        }

        let has_audio_sources = audio_mixer.has_sources();

        let mp4 = Arc::new(std::sync::Mutex::new(
            cap_enc_avfoundation::MP4Encoder::init(
                "mp4",
                source.0.info(),
                has_audio_sources.then_some(AudioMixer::INFO),
                output_path,
                Some(1080),
            )
            .map_err(|e| MediaError::Any(e.to_string().into()))?,
        ));

        use cidre::cm;
        use tracing::error;

        let (first_frame_tx, mut first_frame_rx) =
            tokio::sync::oneshot::channel::<(cm::Time, Timestamp)>();

        if has_audio_sources {
            builder.spawn_source("audio_mixer", audio_mixer);

            let mp4 = mp4.clone();
            builder.spawn_task("audio_encoding", move |ready| {
                let _ = ready.send(Ok(()));
                let mut time = None;

                while let Ok((mut frame, timestamp)) = audio_rx.recv() {
                    if let Ok(first_time) = first_frame_rx.try_recv() {
                        time = Some(first_time);
                    };

                    let Some(time) = time else {
                        continue;
                    };

                    let ts_offset = timestamp.duration_since(start_time);
                    let screen_first_offset = time.1.duration_since(start_time);

                    let Some(ts_offset) = ts_offset.checked_sub(screen_first_offset) else {
                        continue;
                    };

                    let pts = (ts_offset.as_secs_f64() * frame.rate() as f64) as i64;
                    frame.set_pts(Some(pts));

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
            while let Ok((frame, timestamp)) = source.1.recv() {
                if let Ok(mut mp4) = mp4.lock() {
                    if pause_flag.load(std::sync::atomic::Ordering::Relaxed) {
                        mp4.pause();
                    } else {
                        mp4.resume();
                    }

                    if let Some(first_frame_tx) = first_frame_tx.take() {
                        let _ = first_frame_tx.send((frame.pts(), timestamp));
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
impl MakeCapturePipeline for screen_capture::Direct3DCapture {
    fn make_studio_mode_pipeline(
        mut builder: PipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<(Self::VideoFormat, Timestamp)>,
        ),
        output_path: PathBuf,
        start_time: Timestamps,
    ) -> Result<(PipelineBuilder, flume::Receiver<Timestamp>), MediaError>
    where
        Self: Sized,
    {
        use windows::Graphics::SizeInt32;

        cap_mediafoundation_utils::thread_init();

        let screen_config = source.0.info();
        let frame_rate = source.0.config().fps();
        let bitrate_multiplier = 0.1f32;
        let d3d_device = source.0.d3d_device().clone();
        let pixel_format = screen_capture::Direct3DCapture::PIXEL_FORMAT.as_dxgi();
        let capture_resolution = SizeInt32 {
            Width: screen_config.width as i32,
            Height: screen_config.height as i32,
        };

        let mut output = ffmpeg::format::output(&output_path)
            .map_err(|e| MediaError::Any(format!("CreateOutput: {e}").into()))?;

        let screen_encoder = {
            let native_encoder = cap_enc_mediafoundation::H264Encoder::new(
                &d3d_device,
                pixel_format,
                capture_resolution,
                frame_rate,
                bitrate_multiplier,
            );

            match native_encoder {
                Ok(encoder) => {
                    let muxer = cap_mediafoundation_ffmpeg::H264StreamMuxer::new(
                        &mut output,
                        cap_mediafoundation_ffmpeg::MuxerConfig {
                            width: screen_config.width,
                            height: screen_config.height,
                            fps: screen_config.fps(),
                            bitrate: encoder.bitrate(),
                        },
                    )
                    .map_err(|e| MediaError::Any(format!("NativeH264/{e}").into()))?;

                    encoder
                        .start()
                        .map_err(|e| MediaError::Any(format!("ScreenEncoderStart: {e}").into()))?;

                    either::Left((encoder, muxer))
                }
                Err(e) => {
                    tracing::error!("Failed to create native encoder: {e}");
                    tracing::info!("Falling back to software H264 encoder");

                    either::Right(
                        cap_enc_ffmpeg::H264Encoder::builder("screen", screen_config)
                            .build(&mut output)
                            .map_err(|e| MediaError::Any(format!("H264Encoder/{e}").into()))?,
                    )
                }
            }
        };

        output
            .write_header()
            .map_err(|e| MediaError::Any(format!("OutputHeader/{e}").into()))?;

        builder.spawn_source("screen_capture", source.0);

        let (timestamp_tx, timestamp_rx) = flume::bounded(1);

        builder.spawn_task("screen_capture_encoder", move |ready| {
            match screen_encoder {
                either::Left((mut encoder, mut muxer)) => {
                    use windows::Win32::Media::MediaFoundation;

                    cap_mediafoundation_utils::thread_init();

                    let _ = ready.send(Ok(()));

                    let mut timestamp_tx = Some(timestamp_tx);
                    let mut pending_frame: Option<(
                        Self::VideoFormat,
                        Timestamp,
                        windows::Foundation::TimeSpan,
                    )> = None;
                    let mut using_software_encoder = false;

                    'event_loop: while let Ok(e) = encoder.get_event() {
                        match e {
                            MediaFoundation::METransformNeedInput => {
                                let (mut frame, timestamp, frame_time) = if let Some(pending) =
                                    pending_frame.take()
                                {
                                    pending
                                } else {
                                    let Ok((frame, timestamp)) = source.1.recv() else {
                                        break;
                                    };

                                    if let Some(timestamp_tx) = timestamp_tx.take() {
                                        let _ = timestamp_tx.send(timestamp);
                                    }

                                    let frame_time = frame
                                        .inner()
                                        .SystemRelativeTime()
                                        .map_err(|e| format!("FrameTime: {e}"))?;

                                    (frame, timestamp, frame_time)
                                };

                                loop {
                                    match encoder.handle_needs_input(
                                        frame.texture(),
                                        frame_time,
                                    ) {
                                        Ok(()) => break,
                                        Err(
                                            cap_enc_mediafoundation::video::HandleNeedsInputError::ProcessInput(
                                                error,
                                            ),
                                        ) => {
                                            use tracing::warn;
                                            use windows::Win32::Foundation::E_FAIL;

                                            if !using_software_encoder && error.code() == E_FAIL {
                                                warn!(
                                                    "Native H264 ProcessInput failed with {:?}; falling back to software encoder",
                                                    error.code()
                                                );
                                                pending_frame =
                                                    Some((frame, timestamp, frame_time));

                                                let mut software_encoder =
                                                    cap_enc_mediafoundation::H264Encoder::new_software(
                                                        &d3d_device,
                                                        pixel_format,
                                                        capture_resolution,
                                                        frame_rate,
                                                        bitrate_multiplier,
                                                    )
                                                    .map_err(|e| format!(
                                                        "SoftwareEncoderInit: {e}"
                                                    ))?;
                                                software_encoder
                                                    .start()
                                                    .map_err(|e| {
                                                        format!(
                                                            "ScreenEncoderStart: {e}"
                                                        )
                                                    })?;

                                                encoder = software_encoder;
                                                using_software_encoder = true;
                                                continue 'event_loop;
                                            }

                                            return Err(format!(
                                                "NeedsInput: ProcessInput: {error}"
                                            ));
                                        }
                                        Err(err) => {
                                            return Err(format!("NeedsInput: {err}"));
                                        }
                                    }
                                }
                            }
                            MediaFoundation::METransformHaveOutput => {
                                if let Some(output_sample) = encoder
                                    .handle_has_output()
                                    .map_err(|e| format!("HasOutput: {e}"))?
                                {
                                    muxer
                                        .write_sample(&output_sample, &mut output)
                                        .map_err(|e| format!("WriteSample: {e}"))?;
                                }
                            }
                            _ => {}
                        }
                    }

                    encoder
                        .finish()
                        .map_err(|e| format!("EncoderFinish: {e}"))?;
                }
                either::Right(mut encoder) => {
                    let mut first_timestamp = None;
                    let mut timestamp_tx = Some(timestamp_tx);
                    let _ = ready.send(Ok(()));

                    while let Ok((frame, timestamp)) = source.1.recv() {
                        use scap_ffmpeg::AsFFmpeg;

                        if let Some(timestamp_tx) = timestamp_tx.take() {
                            let _ = timestamp_tx.send(timestamp);
                        }

                        let first_timestamp = first_timestamp.get_or_insert(timestamp);

                        let mut ff_frame = frame
                            .as_ffmpeg()
                            .map_err(|e| format!("FrameAsFfmpeg: {e}"))?;

                        let elapsed = timestamp.duration_since(start_time)
                            - first_timestamp.duration_since(start_time);
                        ff_frame.set_pts(Some(encoder.get_pts(elapsed)));

                        encoder.queue_frame(ff_frame, &mut output);
                    }
                    encoder.finish(&mut output);
                }
            }

            output
                .write_trailer()
                .map_err(|e| format!("WriteTrailer: {e}"))?;

            Ok(())
        });

        Ok((builder, timestamp_rx))
    }

    async fn make_instant_mode_pipeline(
        mut builder: PipelineBuilder,
        source: (
            ScreenCaptureSource<Self>,
            flume::Receiver<(Self::VideoFormat, Timestamp)>,
        ),
        audio: Option<Arc<MicrophoneFeedLock>>,
        system_audio: Option<(Receiver<(ffmpeg::frame::Audio, Timestamp)>, AudioInfo)>,
        output_path: PathBuf,
        _pause_flag: Arc<AtomicBool>,
    ) -> Result<PipelineBuilder, MediaError>
    where
        Self: Sized,
    {
        use cap_enc_ffmpeg::{AACEncoder, AudioEncoder};
        use windows::Graphics::SizeInt32;

        cap_mediafoundation_utils::thread_init();

        let start_time = Timestamps::now();

        let (audio_tx, audio_rx) = flume::bounded(64);
        let mut audio_mixer = AudioMixer::builder(audio_tx);

        if let Some(system_audio) = system_audio {
            audio_mixer.add_source(system_audio.1, system_audio.0);
        }

        if let Some(audio) = audio {
            let (tx, rx) = flume::bounded(32);
            audio_mixer.add_source(*audio.audio_info(), rx);
            let source = AudioInputSource::init(audio, tx);

            builder.spawn_source("microphone_capture", source);
        }

        let has_audio_sources = audio_mixer.has_sources();
        let screen_config = source.0.info();
        let frame_rate = 30u32;
        let bitrate_multiplier = 0.15f32;
        let d3d_device = source.0.d3d_device().clone();
        let pixel_format = screen_capture::Direct3DCapture::PIXEL_FORMAT.as_dxgi();
        let input_resolution = SizeInt32 {
            Width: screen_config.width as i32,
            Height: screen_config.height as i32,
        };
        let output_resolution = SizeInt32 {
            Width: screen_config.width as i32,
            Height: screen_config.height as i32,
        };

        let mut output = ffmpeg::format::output(&output_path)
            .map_err(|e| MediaError::Any(format!("CreateOutput: {e}").into()))?;

        let screen_encoder = {
            let native_encoder = cap_enc_mediafoundation::H264Encoder::new_with_scaled_output(
                &d3d_device,
                pixel_format,
                input_resolution,
                output_resolution,
                frame_rate,
                bitrate_multiplier,
            );

            match native_encoder {
                Ok(screen_encoder) => {
                    let screen_muxer = cap_mediafoundation_ffmpeg::H264StreamMuxer::new(
                        &mut output,
                        cap_mediafoundation_ffmpeg::MuxerConfig {
                            width: screen_config.width,
                            height: screen_config.height,
                            fps: frame_rate,
                            bitrate: screen_encoder.bitrate(),
                        },
                    )
                    .map_err(|e| MediaError::Any(format!("NativeH264Muxer/{e}").into()))?;

                    screen_encoder
                        .start()
                        .map_err(|e| MediaError::Any(format!("StartScreenEncoder/{e}").into()))?;

                    either::Left((screen_encoder, screen_muxer))
                }
                Err(e) => {
                    use tracing::{error, info};

                    error!("Failed to create native encoder: {e}");
                    info!("Falling back to software H264 encoder");

                    either::Right(
                        cap_enc_ffmpeg::H264Encoder::builder("screen", screen_config)
                            .build(&mut output)
                            .map_err(|e| MediaError::Any(format!("H264Encoder/{e}").into()))?,
                    )
                }
            }
        };

        let audio_encoder = has_audio_sources
            .then(|| {
                AACEncoder::init("mic_audio", AudioMixer::INFO, &mut output)
                    .map(|v| v.boxed())
                    .map_err(|e| MediaError::Any(e.to_string().into()))
            })
            .transpose()
            .map_err(|e| MediaError::Any(format!("AACEncoder/{e}").into()))?;

        output
            .write_header()
            .map_err(|e| MediaError::Any(format!("OutputHeader/{e}").into()))?;

        let output = Arc::new(std::sync::Mutex::new(output));

        let (first_frame_tx, first_frame_rx) = tokio::sync::oneshot::channel::<Timestamp>();

        if let Some(mut audio_encoder) = audio_encoder {
            builder.spawn_source("audio_mixer", audio_mixer);

            let output = output.clone();
            builder.spawn_task("audio_encoding", move |ready| {
                let _ = ready.send(Ok(()));

                let time = first_frame_rx.blocking_recv().unwrap();
                let screen_first_offset = time.duration_since(start_time);

                while let Ok((mut frame, timestamp)) = audio_rx.recv() {
                    let ts_offset = timestamp.duration_since(start_time);

                    let Some(ts_offset) = ts_offset.checked_sub(screen_first_offset) else {
                        continue;
                    };

                    let pts = (ts_offset.as_secs_f64() * frame.rate() as f64) as i64;
                    frame.set_pts(Some(pts));

                    if let Ok(mut output) = output.lock() {
                        audio_encoder.queue_frame(frame, &mut output)
                    }
                }

                Ok(())
            });
        }

        builder.spawn_source("screen_capture", source.0);

        builder.spawn_task("screen_encoder", move |ready| {
            match screen_encoder {
                either::Left((mut encoder, mut muxer)) => {
                    use windows::Win32::Media::MediaFoundation;

                    cap_mediafoundation_utils::thread_init();

                    let _ = ready.send(Ok(()));

                    let mut first_frame_tx = Some(first_frame_tx);
                    let mut pending_frame: Option<(
                        Self::VideoFormat,
                        windows::Foundation::TimeSpan,
                    )> = None;
                    let mut using_software_encoder = false;

                    'event_loop: while let Ok(e) = encoder.get_event() {
                        match e {
                            MediaFoundation::METransformNeedInput => {
                                use cap_timestamp::PerformanceCounterTimestamp;
                                use tracing::warn;
                                use windows::Win32::Foundation::E_FAIL;

                                let (mut frame, frame_time) = if let Some(pending) =
                                    pending_frame.take()
                                {
                                    pending
                                } else {
                                    let Ok((frame, _)) = source.1.recv() else {
                                        break;
                                    };

                                    let frame_time = frame
                                        .inner()
                                        .SystemRelativeTime()
                                        .map_err(|e| format!("Frame Time: {e}"))?;

                                    (frame, frame_time)
                                };

                                let timestamp = Timestamp::PerformanceCounter(
                                    PerformanceCounterTimestamp::new(frame_time.Duration),
                                );

                                if let Some(first_frame_tx) = first_frame_tx.take() {
                                    let _ = first_frame_tx.send(timestamp);
                                }

                                loop {
                                    match encoder.handle_needs_input(
                                        frame.texture(),
                                        frame_time,
                                    ) {
                                        Ok(()) => break,
                                        Err(
                                            cap_enc_mediafoundation::video::HandleNeedsInputError::ProcessInput(
                                                error,
                                            ),
                                        ) => {
                                            if !using_software_encoder && error.code() == E_FAIL {
                                                warn!(
                                                    "Native H264 ProcessInput failed with {:?}; falling back to software encoder",
                                                    error.code()
                                                );
                                                pending_frame = Some((frame, frame_time));

                                                let mut software_encoder = cap_enc_mediafoundation::H264Encoder::new_with_scaled_output_software(
                                                    &d3d_device,
                                                    pixel_format,
                                                    input_resolution,
                                                    output_resolution,
                                                    frame_rate,
                                                    bitrate_multiplier,
                                                )
                                                .map_err(|e| {
                                                    format!("SoftwareEncoderInit: {e}")
                                                })?;

                                                software_encoder
                                                    .start()
                                                    .map_err(|e| format!(
                                                        "StartScreenEncoder: {e}"
                                                    ))?;

                                                encoder = software_encoder;
                                                using_software_encoder = true;
                                                continue 'event_loop;
                                            }

                                            return Err(format!(
                                                "NeedsInput: ProcessInput: {error}"
                                            ));
                                        }
                                        Err(err) => {
                                            return Err(format!("NeedsInput: {err}"));
                                        }
                                    }
                                }
                            }
                            MediaFoundation::METransformHaveOutput => {
                                if let Some(output_sample) = encoder
                                    .handle_has_output()
                                    .map_err(|e| format!("HasOutput: {e}"))?
                                {
                                    let mut output = output.lock().unwrap();

                                    muxer
                                        .write_sample(&output_sample, &mut *output)
                                        .map_err(|e| format!("WriteSample: {e}"))?;
                                }
                            }
                            _ => {}
                        }
                    }

                    encoder
                        .finish()
                        .map_err(|e| format!("EncoderFinish: {e}"))?;
                }
                either::Right(mut encoder) => {
                    let output = output.clone();

                    let _ = ready.send(Ok(()));

                    while let Ok((frame, _unix_time)) = source.1.recv() {
                        let Ok(mut output) = output.lock() else {
                            continue;
                        };

                        // if pause_flag.load(std::sync::atomic::Ordering::Relaxed) {
                        //     mp4.pause();
                        // } else {
                        //     mp4.resume();
                        // }

                        use scap_ffmpeg::AsFFmpeg;

                        encoder.queue_frame(
                            frame
                                .as_ffmpeg()
                                .map_err(|e| format!("FrameAsFFmpeg: {e}"))?,
                            &mut output,
                        );
                    }
                }
            }

            output
                .lock()
                .map_err(|e| format!("OutputLock: {e}"))?
                .write_trailer()
                .map_err(|e| format!("WriteTrailer: {e}"))?;

            Ok(())
        });

        Ok(builder)
    }
}

type ScreenCaptureReturn<T> = (
    ScreenCaptureSource<T>,
    Receiver<(<T as ScreenCaptureFormat>::VideoFormat, Timestamp)>,
);

#[cfg(target_os = "macos")]
pub type ScreenCaptureMethod = screen_capture::CMSampleBufferCapture;

#[cfg(windows)]
pub type ScreenCaptureMethod = screen_capture::Direct3DCapture;

pub async fn create_screen_capture(
    capture_target: &ScreenCaptureTarget,
    force_show_cursor: bool,
    max_fps: u32,
    audio_tx: Option<Sender<(ffmpeg::frame::Audio, Timestamp)>>,
    start_time: SystemTime,
    #[cfg(windows)] d3d_device: ::windows::Win32::Graphics::Direct3D11::ID3D11Device,
    #[cfg(target_os = "macos")] shareable_content: cidre::arc::R<cidre::sc::ShareableContent>,
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
        #[cfg(windows)]
        d3d_device,
        #[cfg(target_os = "macos")]
        shareable_content,
    )
    .await
    .map(|v| (v, video_rx))
    .map_err(|e| RecordingError::Media(MediaError::TaskLaunch(e.to_string())))
}

#[cfg(windows)]
pub fn create_d3d_device()
-> windows::core::Result<windows::Win32::Graphics::Direct3D11::ID3D11Device> {
    use windows::Win32::Graphics::{
        Direct3D::{D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE},
        Direct3D11::{D3D11_CREATE_DEVICE_FLAG, ID3D11Device},
    };

    let mut device = None;
    let flags = {
        use windows::Win32::Graphics::Direct3D11::D3D11_CREATE_DEVICE_BGRA_SUPPORT;

        let mut flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        if cfg!(feature = "d3ddebug") {
            use windows::Win32::Graphics::Direct3D11::D3D11_CREATE_DEVICE_DEBUG;

            flags |= D3D11_CREATE_DEVICE_DEBUG;
        }
        flags
    };
    let mut result = create_d3d_device_with_type(D3D_DRIVER_TYPE_HARDWARE, flags, &mut device);
    if let Err(error) = &result {
        use windows::Win32::Graphics::Dxgi::DXGI_ERROR_UNSUPPORTED;

        if error.code() == DXGI_ERROR_UNSUPPORTED {
            use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_WARP;

            result = create_d3d_device_with_type(D3D_DRIVER_TYPE_WARP, flags, &mut device);
        }
    }
    result?;

    fn create_d3d_device_with_type(
        driver_type: D3D_DRIVER_TYPE,
        flags: D3D11_CREATE_DEVICE_FLAG,
        device: *mut Option<ID3D11Device>,
    ) -> windows::core::Result<()> {
        unsafe {
            use windows::Win32::{
                Foundation::HMODULE,
                Graphics::Direct3D11::{D3D11_SDK_VERSION, D3D11CreateDevice},
            };

            D3D11CreateDevice(
                None,
                driver_type,
                HMODULE(std::ptr::null_mut()),
                flags,
                None,
                D3D11_SDK_VERSION,
                Some(device),
                None,
                None,
            )
        }
    }

    Ok(device.unwrap())
}
