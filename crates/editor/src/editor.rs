use std::sync::Arc;
use std::time::Instant;

use cap_project::{CursorEvents, RecordingMeta, StudioRecordingMeta};
use cap_rendering::{
    DecodedSegmentFrames, FrameRenderer, Nv12RenderedFrame, ProjectRecordingsMeta, ProjectUniforms,
    RenderVideoConstants, RenderedFrame, RendererLayers,
};
use tokio::sync::{mpsc, oneshot};

#[allow(clippy::large_enum_variant)]
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

pub enum EditorFrameOutput {
    Rgba(RenderedFrame),
    Nv12(Nv12RenderedFrame),
}

pub struct Renderer {
    rx: mpsc::Receiver<RendererMessage>,
    frame_cb: Box<dyn FnMut(EditorFrameOutput) + Send>,
    render_constants: Arc<RenderVideoConstants>,
    #[allow(unused)]
    total_frames: u32,
}

pub struct RendererHandle {
    tx: mpsc::Sender<RendererMessage>,
}

impl Renderer {
    pub fn spawn(
        render_constants: Arc<RenderVideoConstants>,
        frame_cb: Box<dyn FnMut(EditorFrameOutput) + Send>,
        recording_meta: &RecordingMeta,
        meta: &StudioRecordingMeta,
    ) -> Result<RendererHandle, String> {
        let recordings = Arc::new(ProjectRecordingsMeta::new(
            &recording_meta.project_path,
            meta,
        )?);
        let mut max_duration = recordings.duration();

        if let Some(camera_path) = meta.camera_path()
            && let Ok(camera_duration) =
                recordings.get_source_duration(&recording_meta.path(&camera_path))
        {
            max_duration = max_duration.max(camera_duration);
        }

        let total_frames = (30_f64 * max_duration).ceil() as u32;

        let (tx, rx) = mpsc::channel(8);

        let this = Self {
            rx,
            frame_cb,
            render_constants,
            total_frames,
        };

        tokio::spawn(this.run());

        Ok(RendererHandle { tx })
    }

    async fn run(mut self) {
        let mut frame_renderer = FrameRenderer::new(&self.render_constants);

        let mut layers = RendererLayers::new_with_options(
            &self.render_constants.device,
            &self.render_constants.queue,
            self.render_constants.is_software_adapter,
        );

        struct PendingFrame {
            segment_frames: DecodedSegmentFrames,
            uniforms: ProjectUniforms,
            finished: oneshot::Sender<()>,
            cursor: Arc<CursorEvents>,
        }

        let mut pending_frame: Option<PendingFrame> = None;

        loop {
            let frame_to_render = if let Some(pending) = pending_frame.take() {
                Some(pending)
            } else {
                match self.rx.recv().await {
                    Some(RendererMessage::RenderFrame {
                        segment_frames,
                        uniforms,
                        finished,
                        cursor,
                    }) => Some(PendingFrame {
                        segment_frames,
                        uniforms,
                        finished,
                        cursor,
                    }),
                    Some(RendererMessage::Stop { finished }) => {
                        let _ = finished.send(());
                        return;
                    }
                    None => return,
                }
            };

            let Some(mut current) = frame_to_render else {
                continue;
            };

            let queue_drain_start = Instant::now();
            while let Ok(msg) = self.rx.try_recv() {
                match msg {
                    RendererMessage::RenderFrame {
                        segment_frames,
                        uniforms,
                        finished,
                        cursor,
                    } => {
                        let _ = current.finished.send(());
                        current = PendingFrame {
                            segment_frames,
                            uniforms,
                            finished,
                            cursor,
                        };
                    }
                    RendererMessage::Stop { finished } => {
                        let _ = current.finished.send(());
                        let _ = finished.send(());
                        return;
                    }
                }
                if queue_drain_start.elapsed().as_millis() > 5 {
                    break;
                }
            }
            match frame_renderer
                .render_immediate_nv12(
                    current.segment_frames,
                    current.uniforms,
                    &current.cursor,
                    &mut layers,
                )
                .await
            {
                Ok(frame) => {
                    (self.frame_cb)(EditorFrameOutput::Nv12(frame));
                }
                Err(e) => {
                    tracing::error!(error = %e, "Failed to render frame in editor");
                }
            }

            let _ = current.finished.send(());
        }
    }
}

impl RendererHandle {
    pub fn render_frame(
        &self,
        segment_frames: DecodedSegmentFrames,
        uniforms: ProjectUniforms,
        cursor: Arc<CursorEvents>,
    ) {
        let (finished_tx, _finished_rx) = oneshot::channel();

        let _ = self.tx.try_send(RendererMessage::RenderFrame {
            segment_frames,
            uniforms,
            finished: finished_tx,
            cursor,
        });
    }

    pub async fn stop(&self) {
        let (tx, rx) = oneshot::channel();
        if self
            .tx
            .send(RendererMessage::Stop { finished: tx })
            .await
            .is_err()
        {
            tracing::warn!("Failed to send stop message to renderer");
        }
        let _ = rx.await;
    }
}
