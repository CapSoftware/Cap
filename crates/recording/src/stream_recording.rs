use std::{path::PathBuf, sync::Arc, time::SystemTime};

use cap_media::{
    encoders::{AACEncoder, AudioEncoder, H264Encoder, RtmpStream},
    pipeline::{Pipeline, RealTimeClock},
    platform::Bounds,
    sources::{AudioInputSource, AudioMixer, ScreenCaptureFormat, ScreenCaptureSource, ScreenCaptureTarget},
};
use cap_utils::{ensure_dir, spawn_actor};
use tokio::sync::{oneshot, Mutex};
use tracing::info;

use crate::{
    capture_pipeline::{create_screen_capture, ScreenCaptureMethod},
    RecordingBaseInputs, RecordingError,
};

pub struct StreamRecordingHandle {
    ctrl_tx: flume::Sender<StreamRecordingActorControlMessage>,
    pub capture_target: ScreenCaptureTarget,
    pub bounds: Bounds,
}

pub enum StreamRecordingActorControlMessage {
    Stop(oneshot::Sender<Result<CompletedStreamRecording, RecordingError>>),
    Cancel(oneshot::Sender<Result<(), RecordingError>>),
}

pub struct CompletedStreamRecording {
    pub id: String,
    pub project_path: PathBuf,
}

macro_rules! send_message {
    ($ctrl_tx:expr, $variant:path) => {{
        let (tx, rx) = oneshot::channel();
        $ctrl_tx
            .send($variant(tx))
            .map_err(|_| flume::SendError(()))
            .map_err(crate::ActorError::from)?;
        rx.await.map_err(|_| crate::ActorError::ActorStopped)?
    }};
}

impl StreamRecordingHandle {
    pub async fn stop(&self) -> Result<CompletedStreamRecording, RecordingError> {
        send_message!(self.ctrl_tx, StreamRecordingActorControlMessage::Stop)
    }

    pub async fn cancel(&self) -> Result<(), RecordingError> {
        send_message!(self.ctrl_tx, StreamRecordingActorControlMessage::Cancel)
    }
}

pub async fn spawn_stream_recording_actor<'a>(
    id: String,
    recording_dir: PathBuf,
    inputs: RecordingBaseInputs<'a>,
    stream_url: String,
) -> Result<(StreamRecordingHandle, oneshot::Receiver<()>), RecordingError> {
    ensure_dir(&recording_dir)?;

    let (done_tx, done_rx) = oneshot::channel();
    let start_time = SystemTime::now();

    // Set up system audio if enabled
    let system_audio = if inputs.capture_system_audio {
        let (tx, rx) = flume::bounded(64);
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };

    let (screen_source, screen_rx) = create_screen_capture(
        &inputs.capture_target,
        true,
        true,
        30,
        system_audio.0,
        start_time,
    )?;

    let screen_config = screen_source.info();

    let clock = RealTimeClock::<()>::new();
    let mut builder = Pipeline::builder(clock);

    // Set up audio mixer
    let (audio_tx, audio_rx) = flume::bounded(64);
    let mut audio_mixer = AudioMixer::new(audio_tx);

    // Add system audio if available
    if let Some((config, channel)) = 
        Some(ScreenCaptureMethod::audio_info()).zip(system_audio.1.clone()) 
    {
        audio_mixer.add_source(config, channel);
    }

    // Add microphone audio if available
    if let Some(audio) = inputs.mic_feed {
        let sink = audio_mixer.sink(audio.audio_info());
        let source = AudioInputSource::init(audio, sink.tx, start_time);
        builder.spawn_source("microphone_capture", source);
    }

    let has_audio_sources = audio_mixer.has_sources();

    let stream = Arc::new(Mutex::new(RtmpStream::init(
        "stream",
        stream_url,
        |o| {
            // Use direct bitrate control for streaming - target 4000 kbps for video
            tracing::info!("Stream encoder config: {}x{} @ {}fps, target video bitrate: 4000kbps", 
                screen_config.width, screen_config.height, 
                screen_config.frame_rate.0 as f32 / screen_config.frame_rate.1 as f32);
            
            H264Encoder::builder("stream", screen_config)
                .with_direct_bitrate_kbps(4000) // 4 Mbps video
                .with_preset(cap_media::encoders::H264Preset::Ultrafast) // Use ultrafast for low latency
                .build(o)
        },
        |o| {
            has_audio_sources.then(|| {
                // Use streaming AAC encoder with 128kbps instead of 320kbps
                AACEncoder::streaming_factory("stream_audio", AudioMixer::info())(o).map(|v| v.boxed())
            })
        },
    )?));

    builder.spawn_source("screen_capture", screen_source.clone());

    // Add audio mixer source if we have audio
    if has_audio_sources {
        builder.spawn_source("audio_mixer", audio_mixer);

        // Set up audio encoding task - block until completion
        let stream_audio = stream.clone();
        builder.spawn_task("stream_audio", move |ready| {
            let _ = ready.send(Ok(()));
            
            // Block in this task until completion instead of spawning a thread
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async {
                let mut audio_frame_count = 0;
                while let Ok(frame) = audio_rx.recv() {
                    audio_frame_count += 1;
                    if audio_frame_count % 100 == 0 { // Log every 100 audio frames
                        tracing::info!("Processed {} audio frames", audio_frame_count);
                    }
                    
                    let mut s = stream_audio.lock().await;
                    if let Err(e) = s.queue_audio_frame(frame) {
                        tracing::error!("RTMP audio stream error at frame {}: {}", audio_frame_count, e);
                        break;
                    }
                }
                tracing::info!("Audio encoding task finished after {} frames", audio_frame_count);
            });
        });
    }

    // Set up video encoding task - block until completion
    {
        let stream = stream.clone();
        builder.spawn_task("stream_video", move |ready| {
            let _ = ready.send(Ok(()));
            
            // Block in this task until completion instead of spawning a thread
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async {
                let mut frame_count = 0;
                while let Ok((frame, timestamp)) = screen_rx.recv() {
                    frame_count += 1;
                    if frame_count % 30 == 0 { // Log every second at 30fps
                        tracing::info!("Processed {} frames, current timestamp: {:.2}s", frame_count, timestamp);
                    }
                    
                    let mut s = stream.lock().await;
                    if let Err(e) = s.queue_video_frame(frame) {
                        tracing::error!("RTMP stream error at frame {}: {}", frame_count, e);
                        break;
                    }
                }
                tracing::info!("Video encoding task finished after {} frames", frame_count);
                
                let mut s = stream.lock().await;
                s.finish();
                tracing::info!("RTMP stream finished");
            });
        });
    }

    let (mut pipeline, mut pipeline_done_rx) = builder.build().await?;

    pipeline.play().await?;

    let (ctrl_tx, ctrl_rx) = flume::bounded(1);

    spawn_actor({
        async move {
            let mut pipeline = pipeline;
            loop {
                let msg = tokio::select! {
                    _ = &mut pipeline_done_rx => { break; }
                    msg = ctrl_rx.recv_async() => { match msg { Ok(m) => m, Err(_) => break } }
                };

                match msg {
                    StreamRecordingActorControlMessage::Stop(tx) => {
                        let _ = pipeline.shutdown().await;
                        tx.send(Ok(CompletedStreamRecording { id: id.clone(), project_path: recording_dir.clone() })).ok();
                        break;
                    }
                    StreamRecordingActorControlMessage::Cancel(tx) => {
                        let _ = pipeline.shutdown().await;
                        tx.send(Ok(())).ok();
                        break;
                    }
                }
            }
            done_tx.send(()).ok();
        }
    });

    Ok((
        StreamRecordingHandle {
            ctrl_tx,
            capture_target: inputs.capture_target,
            bounds: screen_source.get_bounds().clone(),
        },
        done_rx,
    ))
}
