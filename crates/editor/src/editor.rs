use std::{sync::Arc, time::Instant};

use cap_media::{feeds::RawCameraFrame, frame_ws::WSFrame};
use cap_project::{BackgroundSource, CursorEvents, RecordingMeta, StudioRecordingMeta, XY};
use cap_rendering::{
    decoder::DecodedFrame, DecodedSegmentFrames, FrameRenderer, ProjectRecordings, ProjectUniforms,
    RenderVideoConstants, RendererLayers,
};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

pub enum RendererMessage {
    RenderFrame {
        segment_frames: DecodedSegmentFrames,
        uniforms: ProjectUniforms,
        finished: oneshot::Sender<()>,
        cursor: Arc<CursorEvents>,
    },
    Stop {
        finished: oneshot::Sender<()>,
    },
}

pub struct Renderer {
    rx: mpsc::Receiver<RendererMessage>,
    frame_tx: flume::Sender<WSFrame>,
    render_constants: Arc<RenderVideoConstants>,
    total_frames: u32,
}

pub struct RendererHandle {
    tx: mpsc::Sender<RendererMessage>,
}

impl Renderer {
    pub fn spawn(
        render_constants: Arc<RenderVideoConstants>,
        frame_tx: flume::Sender<WSFrame>,
        recording_meta: &RecordingMeta,
        meta: &StudioRecordingMeta,
    ) -> Result<RendererHandle, String> {
        let recordings = Arc::new(ProjectRecordings::new(&recording_meta.project_path, meta)?);
        let mut max_duration = recordings.duration();

        // Check camera duration if it exists
        if let Some(camera_path) = meta.camera_path() {
            if let Ok(camera_duration) =
                recordings.get_source_duration(&recording_meta.path(&camera_path))
            {
                max_duration = max_duration.max(camera_duration);
            }
        }

        let total_frames = (30_f64 * max_duration).ceil() as u32;

        let (tx, rx) = mpsc::channel(4);

        let this = Self {
            rx,
            frame_tx,
            render_constants,
            total_frames,
        };

        tokio::spawn(this.run());

        Ok(RendererHandle { tx })
    }

    async fn run(mut self) {
        let mut frame_task: Option<JoinHandle<()>> = None;

        let mut frame_renderer = FrameRenderer::new(&self.render_constants);

        let mut layers = RendererLayers::new(&self.render_constants.device);

        loop {
            while let Some(msg) = self.rx.recv().await {
                match msg {
                    RendererMessage::RenderFrame {
                        segment_frames,
                        uniforms,
                        finished,
                        cursor,
                    } => {
                        if let Some(task) = frame_task.as_ref() {
                            if task.is_finished() {
                                frame_task = None
                            } else {
                                continue;
                            }
                        }

                        let frame_tx = self.frame_tx.clone();

                        let output_size = uniforms.output_size;

                        let frame = frame_renderer
                            .render(segment_frames, uniforms, &cursor, &mut layers)
                            .await
                            .unwrap();

                        frame_tx
                            .try_send(WSFrame {
                                data: frame.data,
                                width: output_size.0,
                                height: output_size.1,
                                stride: frame.padded_bytes_per_row,
                            })
                            .ok();
                        finished.send(()).ok();
                    }
                    RendererMessage::Stop { finished } => {
                        if let Some(task) = frame_task.take() {
                            task.abort();
                        }
                        let _ = finished.send(());
                        return;
                    }
                }
            }
        }
    }
}

impl RendererHandle {
    async fn send(&self, msg: RendererMessage) {
        self.tx.send(msg).await.unwrap();
    }

    pub async fn render_frame(
        &self,
        segment_frames: DecodedSegmentFrames,
        uniforms: ProjectUniforms,
        cursor: Arc<CursorEvents>,
    ) {
        let (finished_tx, finished_rx) = oneshot::channel();

        self.send(RendererMessage::RenderFrame {
            segment_frames,
            uniforms,
            finished: finished_tx,
            cursor,
        })
        .await;

        finished_rx.await.ok();
    }

    pub async fn stop(&self) {
        // Send a stop message to the renderer
        let (tx, rx) = oneshot::channel();
        if let Err(_) = self.tx.send(RendererMessage::Stop { finished: tx }).await {
            println!("Failed to send stop message to renderer");
        }
        // Wait for the renderer to acknowledge the stop
        let _ = rx.await;
    }
}
