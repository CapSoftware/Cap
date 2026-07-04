use std::sync::Arc;
use std::time::Instant;

use cap_project::{CursorEvents, ProjectConfiguration};
use cap_rendering::{
    DecodedSegmentFrames, FrameRenderer, Nv12RenderedFrame, ProjectUniforms, RenderVideoConstants,
    RenderedFrame, RendererLayers,
};
use tokio::sync::{mpsc, oneshot};

use crate::telemetry::{PlaybackRenderOutputFormat, PlaybackTelemetry, PlaybackTelemetryEvent};

#[allow(clippy::large_enum_variant)]
pub enum RendererMessage {
    PrepareOutputSize {
        width: u32,
        height: u32,
    },
    RenderFrame {
        segment_frames: DecodedSegmentFrames,
        uniforms: ProjectUniforms,
        finished: oneshot::Sender<bool>,
        cursor: Arc<CursorEvents>,
        queued_at: Instant,
    },
    Stop {
        finished: oneshot::Sender<()>,
    },
}

pub enum EditorFrameOutput {
    Rgba(RenderedFrame),
    Nv12(Nv12RenderedFrame),
}

pub type RendererLayersReceiver = oneshot::Receiver<RendererLayers>;

pub struct Renderer {
    rx: mpsc::Receiver<RendererMessage>,
    frame_cb: Box<dyn FnMut(EditorFrameOutput) + Send>,
    render_constants: Arc<RenderVideoConstants>,
    layers_rx: RendererLayersReceiver,
    telemetry: Option<PlaybackTelemetry>,
}

pub struct RendererHandle {
    tx: mpsc::Sender<RendererMessage>,
    telemetry: Option<PlaybackTelemetry>,
}

pub fn start_renderer_layers_creation(
    render_constants: &Arc<RenderVideoConstants>,
    project: &ProjectConfiguration,
) -> RendererLayersReceiver {
    let (layers_tx, layers_rx) = oneshot::channel();
    let constants = render_constants.clone();
    let use_svg = project.cursor.use_svg;
    let cursor_type = project.cursor.cursor_type().clone();
    std::thread::Builder::new()
        .name("renderer-layers-init".into())
        .spawn(move || {
            let mut layers = RendererLayers::new_with_options(
                &constants.device,
                &constants.queue,
                constants.is_software_adapter,
            );
            layers.preload_cursor_assets(&constants, use_svg, &cursor_type);
            let _ = layers_tx.send(layers);
        })
        .expect("failed to spawn renderer layers init thread");
    layers_rx
}

pub async fn finish_renderer_layers_creation(
    layers_rx: RendererLayersReceiver,
) -> RendererLayersReceiver {
    let (layers_tx, ready_layers_rx) = oneshot::channel();
    if let Ok(layers) = layers_rx.await {
        let _ = layers_tx.send(layers);
    }
    ready_layers_rx
}

impl Renderer {
    pub fn spawn(
        render_constants: Arc<RenderVideoConstants>,
        frame_cb: Box<dyn FnMut(EditorFrameOutput) + Send>,
        layers_rx: RendererLayersReceiver,
    ) -> Result<RendererHandle, String> {
        Self::spawn_with_telemetry(render_constants, frame_cb, layers_rx, None)
    }

    pub fn spawn_with_telemetry(
        render_constants: Arc<RenderVideoConstants>,
        frame_cb: Box<dyn FnMut(EditorFrameOutput) + Send>,
        layers_rx: RendererLayersReceiver,
        telemetry: Option<PlaybackTelemetry>,
    ) -> Result<RendererHandle, String> {
        let (tx, rx) = mpsc::channel(64);

        let this = Self {
            rx,
            frame_cb,
            render_constants,
            layers_rx,
            telemetry: telemetry.clone(),
        };

        tokio::spawn(this.run());

        Ok(RendererHandle { tx, telemetry })
    }

    async fn run(self) {
        let Renderer {
            mut rx,
            mut frame_cb,
            render_constants,
            layers_rx,
            telemetry,
        } = self;

        let mut frame_renderer = FrameRenderer::new(&render_constants);

        let mut layers = match layers_rx.await {
            Ok(layers) => layers,
            Err(_) => {
                tracing::error!("Failed to receive pre-created renderer layers, creating inline");
                let mut layers = RendererLayers::new_with_options(
                    &render_constants.device,
                    &render_constants.queue,
                    render_constants.is_software_adapter,
                );
                let project = render_constants.recording_meta.project_config();
                layers.preload_cursor_assets(
                    &render_constants,
                    project.cursor.use_svg,
                    project.cursor.cursor_type(),
                );
                layers
            }
        };

        struct PendingFrame {
            segment_frames: DecodedSegmentFrames,
            uniforms: ProjectUniforms,
            finished: oneshot::Sender<bool>,
            cursor: Arc<CursorEvents>,
            queued_at: Instant,
        }

        let mut pending_frame: Option<PendingFrame> = None;

        loop {
            let frame_to_render = if let Some(pending) = pending_frame.take() {
                Some(pending)
            } else {
                match rx.recv().await {
                    Some(RendererMessage::PrepareOutputSize { width, height }) => {
                        Self::prepare_output_size(&telemetry, &mut frame_renderer, width, height);
                        continue;
                    }
                    Some(RendererMessage::RenderFrame {
                        segment_frames,
                        uniforms,
                        finished,
                        cursor,
                        queued_at,
                    }) => Some(PendingFrame {
                        segment_frames,
                        uniforms,
                        finished,
                        cursor,
                        queued_at,
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

            let mut drained_count = 0u32;
            let queue_drain_start = Instant::now();
            while let Ok(msg) = rx.try_recv() {
                match msg {
                    RendererMessage::PrepareOutputSize { width, height } => {
                        Self::prepare_output_size(&telemetry, &mut frame_renderer, width, height);
                    }
                    RendererMessage::RenderFrame {
                        segment_frames,
                        uniforms,
                        finished,
                        cursor,
                        queued_at,
                    } => {
                        let dropped_frame_number = current.uniforms.frame_number;
                        let replacement_frame_number = uniforms.frame_number;
                        let _ = current.finished.send(false);
                        if let Some(telemetry) = &telemetry {
                            telemetry.emit(PlaybackTelemetryEvent::RendererDropped {
                                frame_number: dropped_frame_number,
                                replacement_frame_number,
                            });
                        }
                        current = PendingFrame {
                            segment_frames,
                            uniforms,
                            finished,
                            cursor,
                            queued_at,
                        };
                        drained_count += 1;
                    }
                    RendererMessage::Stop { finished } => {
                        let _ = current.finished.send(false);
                        let _ = finished.send(());
                        return;
                    }
                }
                if queue_drain_start.elapsed().as_millis() > 5 {
                    break;
                }
            }

            let queue_wait = current.queued_at.elapsed();
            let drain_duration = queue_drain_start.elapsed();
            let flush_start = Instant::now();
            if drained_count > 0 {
                let _ = frame_renderer.flush_pipeline().await;
            }
            let flush_duration = if drained_count > 0 {
                flush_start.elapsed()
            } else {
                std::time::Duration::ZERO
            };

            let render_start = Instant::now();
            let input_frame_number = current.uniforms.frame_number;
            match frame_renderer
                .render_immediate_with_timings(
                    current.segment_frames,
                    current.uniforms,
                    &current.cursor,
                    true,
                    &mut layers,
                )
                .await
            {
                Ok((frame, render_stage_timings)) => {
                    let render_duration = render_start.elapsed();
                    let frame_number = frame.frame_number;
                    let output_format = PlaybackRenderOutputFormat::Rgba;
                    let callback_start = Instant::now();
                    (frame_cb)(EditorFrameOutput::Rgba(frame));
                    let callback_duration = callback_start.elapsed();
                    if let Some(telemetry) = &telemetry {
                        telemetry.emit(PlaybackTelemetryEvent::RendererFrame {
                            frame_number,
                            input_frame_number,
                            queue_wait,
                            drain_duration,
                            flush_duration,
                            render_duration,
                            render_stage_timings: Box::new(render_stage_timings),
                            callback_duration,
                            drained_count,
                            output_format,
                        });
                    }
                    let _ = current.finished.send(true);
                }
                Err(e) => {
                    tracing::error!(error = %e, "Failed to render frame in editor");
                    let _ = current.finished.send(false);
                }
            }
        }
    }

    fn prepare_output_size(
        telemetry: &Option<PlaybackTelemetry>,
        frame_renderer: &mut FrameRenderer<'_>,
        width: u32,
        height: u32,
    ) {
        let start = Instant::now();
        frame_renderer.prepare_output_size(width, height);
        if let Some(telemetry) = telemetry {
            telemetry.emit(PlaybackTelemetryEvent::RendererPrepared {
                output_width: width,
                output_height: height,
                duration: start.elapsed(),
            });
        }
    }
}

impl RendererHandle {
    pub fn prepare_output_size(&self, width: u32, height: u32) {
        let _ = self
            .tx
            .try_send(RendererMessage::PrepareOutputSize { width, height });
    }

    pub fn render_frame(
        &self,
        segment_frames: DecodedSegmentFrames,
        uniforms: ProjectUniforms,
        cursor: Arc<CursorEvents>,
    ) {
        let (finished_tx, _finished_rx) = oneshot::channel();
        let frame_number = uniforms.frame_number;
        if self
            .tx
            .try_send(RendererMessage::RenderFrame {
                segment_frames,
                uniforms,
                finished: finished_tx,
                cursor,
                queued_at: Instant::now(),
            })
            .is_err()
            && let Some(telemetry) = &self.telemetry
        {
            telemetry.emit(PlaybackTelemetryEvent::RendererSendFailed { frame_number });
        }
    }

    pub fn render_frame_blocking(
        &self,
        segment_frames: DecodedSegmentFrames,
        uniforms: ProjectUniforms,
        cursor: Arc<CursorEvents>,
    ) {
        let (finished_tx, _finished_rx) = oneshot::channel();
        let frame_number = uniforms.frame_number;
        let msg = RendererMessage::RenderFrame {
            segment_frames,
            uniforms,
            finished: finished_tx,
            cursor,
            queued_at: Instant::now(),
        };
        if self.tx.blocking_send(msg).is_err()
            && let Some(telemetry) = &self.telemetry
        {
            telemetry.emit(PlaybackTelemetryEvent::RendererSendFailed { frame_number });
        }
    }

    pub async fn render_frame_confirmed(
        &self,
        segment_frames: DecodedSegmentFrames,
        uniforms: ProjectUniforms,
        cursor: Arc<CursorEvents>,
    ) -> bool {
        let (finished_tx, finished_rx) = oneshot::channel();
        let frame_number = uniforms.frame_number;
        let msg = RendererMessage::RenderFrame {
            segment_frames,
            uniforms,
            finished: finished_tx,
            cursor,
            queued_at: Instant::now(),
        };
        if self.tx.send(msg).await.is_err() {
            if let Some(telemetry) = &self.telemetry {
                telemetry.emit(PlaybackTelemetryEvent::RendererSendFailed { frame_number });
            }
            return false;
        }

        finished_rx.await.unwrap_or(false)
    }

    pub fn render_frame_wait(
        &self,
        segment_frames: DecodedSegmentFrames,
        uniforms: ProjectUniforms,
        cursor: Arc<CursorEvents>,
    ) -> bool {
        let (finished_tx, finished_rx) = oneshot::channel();
        let frame_number = uniforms.frame_number;
        let msg = RendererMessage::RenderFrame {
            segment_frames,
            uniforms,
            finished: finished_tx,
            cursor,
            queued_at: Instant::now(),
        };
        if self.tx.blocking_send(msg).is_err() {
            if let Some(telemetry) = &self.telemetry {
                telemetry.emit(PlaybackTelemetryEvent::RendererSendFailed { frame_number });
            }
            return false;
        }

        finished_rx.blocking_recv().unwrap_or(false)
    }

    pub async fn stop(&self) {
        let (tx, rx) = oneshot::channel();
        if self
            .tx
            .send(RendererMessage::Stop { finished: tx })
            .await
            .is_err()
        {
            tracing::debug!("Renderer stop message skipped because renderer task already stopped");
        }
        let _ = rx.await;
    }
}
