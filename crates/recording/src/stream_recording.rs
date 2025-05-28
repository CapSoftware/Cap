use std::{path::PathBuf, sync::Arc, time::SystemTime};

use cap_media::{
    encoders::{H264Encoder, RtmpStream},
    pipeline::{Pipeline, RealTimeClock},
    platform::Bounds,
    sources::{ScreenCaptureSource, ScreenCaptureTarget},
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

pub async fn spawn_stream_recording_actor<'a>(
    id: String,
    recording_dir: PathBuf,
    inputs: RecordingBaseInputs<'a>,
    stream_url: String,
) -> Result<(StreamRecordingHandle, oneshot::Receiver<()>), RecordingError> {
    ensure_dir(&recording_dir)?;

    let (done_tx, done_rx) = oneshot::channel();
    let start_time = SystemTime::now();

    let (screen_source, screen_rx) = create_screen_capture(
        &inputs.capture_target,
        true,
        true,
        30,
        None,
        start_time,
    )?;

    let screen_config = screen_source.info();

    let clock = RealTimeClock::<()>::new();
    let mut builder = Pipeline::builder(clock);

    let stream = Arc::new(Mutex::new(RtmpStream::init(
        "stream",
        stream_url,
        |o| H264Encoder::builder("stream", screen_config).build(o),
        |_| None,
    )?));

    builder.spawn_source("screen_capture", screen_source.clone());

    {
        let stream = stream.clone();
        builder.spawn_task("stream_video", move |ready| {
            let _ = ready.send(Ok(()));
            while let Ok((frame, _)) = screen_rx.recv() {
                if let Ok(mut s) = stream.lock() {
                    s.queue_video_frame(frame);
                }
            }
            if let Ok(mut s) = stream.lock() {
                s.finish();
            }
        });
    }

    let (mut pipeline, pipeline_done_rx) = builder.build().await?;

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
