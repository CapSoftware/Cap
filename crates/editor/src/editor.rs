use std::sync::Arc;
use std::time::Instant;

use cap_project::{CursorEvents, RecordingMeta, StudioRecordingMeta};
use cap_rendering::{
    DecodedSegmentFrames, FrameRenderer, ProjectRecordingsMeta, ProjectUniforms,
    RenderVideoConstants, RenderedFrame, RendererLayers,
};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, info};

#[allow(clippy::large_enum_variant)]
pub enum RendererMessage {
    RenderFrame {
        segment_frames: DecodedSegmentFrames,
        uniforms: ProjectUniforms,
        finished: oneshot::Sender<()>,
        cursor: Arc<CursorEvents>,
        frame_number: u32,
    },
    Stop {
        finished: oneshot::Sender<()>,
    },
}

pub struct Renderer {
    rx: mpsc::Receiver<RendererMessage>,
    frame_cb: Box<dyn FnMut(RenderedFrame) + Send>,
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
        frame_cb: Box<dyn FnMut(RenderedFrame) + Send>,
        recording_meta: &RecordingMeta,
        meta: &StudioRecordingMeta,
    ) -> Result<RendererHandle, String> {
        let recordings = Arc::new(ProjectRecordingsMeta::new(
            &recording_meta.project_path,
            meta,
        )?);
        let mut max_duration = recordings.duration();

        // Check camera duration if it exists
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

        let mut layers =
            RendererLayers::new(&self.render_constants.device, &self.render_constants.queue);

        struct PendingFrame {
            segment_frames: DecodedSegmentFrames,
            uniforms: ProjectUniforms,
            finished: oneshot::Sender<()>,
            cursor: Arc<CursorEvents>,
            frame_number: u32,
        }

        let mut pending_frame: Option<PendingFrame> = None;

        let mut frames_rendered = 0u64;
        let mut frames_dropped = 0u64;
        let mut total_render_time_us = 0u64;
        let mut total_callback_time_us = 0u64;
        let mut max_render_time_us = 0u64;
        let mut max_callback_time_us = 0u64;
        let mut last_metrics_log = Instant::now();
        let start_time = Instant::now();

        info!("[PERF:EDITOR_RENDER] renderer loop started");

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
                        frame_number,
                    }) => Some(PendingFrame {
                        segment_frames,
                        uniforms,
                        finished,
                        cursor,
                        frame_number,
                    }),
                    Some(RendererMessage::Stop { finished }) => {
                        let _ = finished.send(());
                        let elapsed = start_time.elapsed();
                        let avg_render_time = if frames_rendered > 0 {
                            total_render_time_us / frames_rendered
                        } else {
                            0
                        };
                        let avg_callback_time = if frames_rendered > 0 {
                            total_callback_time_us / frames_rendered
                        } else {
                            0
                        };
                        info!(
                            elapsed_ms = elapsed.as_millis() as u64,
                            frames_rendered = frames_rendered,
                            frames_dropped = frames_dropped,
                            avg_render_time_us = avg_render_time,
                            avg_callback_time_us = avg_callback_time,
                            max_render_time_us = max_render_time_us,
                            max_callback_time_us = max_callback_time_us,
                            "[PERF:EDITOR_RENDER] renderer stopped - final metrics"
                        );
                        return;
                    }
                    None => return,
                }
            };

            let Some(mut current) = frame_to_render else {
                continue;
            };

            let mut dropped_in_batch = 0u32;
            while let Ok(msg) = self.rx.try_recv() {
                match msg {
                    RendererMessage::RenderFrame {
                        segment_frames,
                        uniforms,
                        finished,
                        cursor,
                        frame_number,
                    } => {
                        dropped_in_batch += 1;
                        let _ = current.finished.send(());
                        current = PendingFrame {
                            segment_frames,
                            uniforms,
                            finished,
                            cursor,
                            frame_number,
                        };
                    }
                    RendererMessage::Stop { finished } => {
                        let _ = current.finished.send(());
                        let _ = finished.send(());
                        return;
                    }
                }
            }

            if dropped_in_batch > 0 {
                frames_dropped += dropped_in_batch as u64;
                debug!(
                    dropped_frames = dropped_in_batch,
                    total_dropped = frames_dropped,
                    "[PERF:EDITOR_RENDER] dropped frames to catch up"
                );

                // #region agent log
                use std::io::Write;
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open("/Users/macbookuser/Documents/GitHub/cap/.cursor/debug.log")
                {
                    let _ = writeln!(
                        f,
                        r#"{{"hypothesisId":"A","location":"editor.rs:frames_dropped","message":"Renderer dropped frames due to backpressure","data":{{"dropped_in_batch":{},"total_dropped":{},"rendering_frame":{}}},"timestamp":{}}}"#,
                        dropped_in_batch,
                        frames_dropped,
                        current.frame_number,
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_millis()
                    );
                }
                // #endregion
            }

            // #region agent log
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open("/Users/macbookuser/Documents/GitHub/cap/.cursor/debug.log")
            {
                let _ = writeln!(
                    f,
                    r#"{{"hypothesisId":"A","location":"editor.rs:render_start","message":"Starting GPU render","data":{{"frame_number":{}}},"timestamp":{}}}"#,
                    current.frame_number,
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis()
                );
            }
            // #endregion

            let render_start = Instant::now();
            let frame = frame_renderer
                .render(
                    current.segment_frames,
                    current.uniforms,
                    &current.cursor,
                    &mut layers,
                )
                .await
                .unwrap();
            let render_time = render_start.elapsed();

            // #region agent log
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open("/Users/macbookuser/Documents/GitHub/cap/.cursor/debug.log")
            {
                let _ = writeln!(
                    f,
                    r#"{{"hypothesisId":"A","location":"editor.rs:render_complete","message":"GPU render complete","data":{{"frame_number":{},"render_time_us":{}}},"timestamp":{}}}"#,
                    current.frame_number,
                    render_time.as_micros(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis()
                );
            }
            // #endregion

            let callback_start = Instant::now();
            (self.frame_cb)(frame);
            let callback_time = callback_start.elapsed();

            frames_rendered += 1;
            let render_time_us = render_time.as_micros() as u64;
            let callback_time_us = callback_time.as_micros() as u64;
            total_render_time_us += render_time_us;
            total_callback_time_us += callback_time_us;
            max_render_time_us = max_render_time_us.max(render_time_us);
            max_callback_time_us = max_callback_time_us.max(callback_time_us);

            debug!(
                frame_number = current.frame_number,
                render_time_us = render_time_us,
                callback_time_us = callback_time_us,
                "[PERF:EDITOR_RENDER] frame rendered"
            );

            if last_metrics_log.elapsed().as_secs() >= 2 && frames_rendered > 0 {
                let avg_render_time = total_render_time_us / frames_rendered;
                let avg_callback_time = total_callback_time_us / frames_rendered;
                info!(
                    frames_rendered = frames_rendered,
                    frames_dropped = frames_dropped,
                    avg_render_time_us = avg_render_time,
                    avg_callback_time_us = avg_callback_time,
                    max_render_time_us = max_render_time_us,
                    max_callback_time_us = max_callback_time_us,
                    "[PERF:EDITOR_RENDER] periodic metrics"
                );
                last_metrics_log = Instant::now();
            }

            let _ = current.finished.send(());
        }
    }
}

impl RendererHandle {
    async fn send(&self, msg: RendererMessage) {
        let _ = self.tx.send(msg).await;
    }

    pub async fn render_frame(
        &self,
        segment_frames: DecodedSegmentFrames,
        uniforms: ProjectUniforms,
        cursor: Arc<CursorEvents>,
        frame_number: u32,
    ) {
        let (finished_tx, finished_rx) = oneshot::channel();

        self.send(RendererMessage::RenderFrame {
            segment_frames,
            uniforms,
            finished: finished_tx,
            cursor,
            frame_number,
        })
        .await;

        let _ = finished_rx.await;
    }

    pub async fn stop(&self) {
        // Send a stop message to the renderer
        let (tx, rx) = oneshot::channel();
        if self
            .tx
            .send(RendererMessage::Stop { finished: tx })
            .await
            .is_err()
        {
            println!("Failed to send stop message to renderer");
        }
        // Wait for the renderer to acknowledge the stop
        let _ = rx.await;
    }
}
