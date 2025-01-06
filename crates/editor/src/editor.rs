use std::{sync::Arc, time::Instant};

use cap_media::frame_ws::WSFrame;
use cap_project::{BackgroundSource, ProjectConfiguration, RecordingMeta};
use cap_rendering::{
    decoder::DecodedFrame, produce_frame, ProjectRecordings, ProjectUniforms, RenderVideoConstants,
};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

pub enum RendererMessage {
    RenderFrame {
        screen_frame: DecodedFrame,
        camera_frame: Option<DecodedFrame>,
        background: BackgroundSource,
        uniforms: ProjectUniforms,
        time: f32, // Add this field
        finished: oneshot::Sender<()>,
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
        meta: &RecordingMeta,
    ) -> RendererHandle {
        let recordings = ProjectRecordings::new(meta);
        let mut max_duration = recordings.duration();

        // Check camera duration if it exists
        if let Some(camera_path) = meta.content.camera_path() {
            if let Ok(camera_duration) = recordings.get_source_duration(&camera_path) {
                max_duration = max_duration.max(camera_duration);
            }
        }

        let total_frames = (30_f64 * max_duration).ceil() as u32;
        println!("Editor total frames: {total_frames}");

        let (tx, rx) = mpsc::channel(4);

        let this = Self {
            rx,
            frame_tx,
            render_constants,
            total_frames,
        };

        tokio::spawn(this.run());

        RendererHandle { tx }
    }

    async fn run(mut self) {
        let mut frame_task: Option<JoinHandle<()>> = None;

        loop {
            while let Some(msg) = self.rx.recv().await {
                match msg {
                    RendererMessage::RenderFrame {
                        screen_frame,
                        camera_frame,
                        background,
                        uniforms,
                        time,
                        finished,
                    } => {
                        if let Some(task) = frame_task.as_ref() {
                            if task.is_finished() {
                                frame_task = None
                            } else {
                                continue;
                            }
                        }

                        let render_constants = self.render_constants.clone();
                        let frame_tx = self.frame_tx.clone();
                        let total_frames = self.total_frames;

                        frame_task = Some(tokio::spawn(async move {
                            let frame = produce_frame(
                                &render_constants,
                                &screen_frame,
                                &camera_frame,
                                cap_rendering::Background::from(background),
                                &uniforms,
                                time,
                                total_frames,
                            )
                            .await
                            .unwrap();

                            frame_tx
                                .try_send(WSFrame {
                                    data: frame.data,
                                    width: uniforms.output_size.0,
                                    height: uniforms.output_size.1,
                                    stride: frame.padded_bytes_per_row,
                                })
                                .ok();
                            finished.send(()).ok();
                        }));
                    }
                    RendererMessage::Stop { finished } => {
                        // Cancel any ongoing frame task
                        if let Some(task) = frame_task.take() {
                            task.abort();
                        }
                        // Acknowledge the stop
                        let _ = finished.send(());
                        // Exit the run loop
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
        screen_frame: DecodedFrame,
        camera_frame: Option<DecodedFrame>,
        background: BackgroundSource,
        uniforms: ProjectUniforms,
        time: f32, // Add this parameter
    ) {
        let (finished_tx, finished_rx) = oneshot::channel();

        self.send(RendererMessage::RenderFrame {
            screen_frame,
            camera_frame,
            background,
            uniforms,
            time, // Pass the time
            finished: finished_tx,
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
