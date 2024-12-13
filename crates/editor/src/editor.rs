use std::{sync::Arc, time::Instant};

use cap_project::{BackgroundSource, ProjectConfiguration};
use cap_rendering::{decoder::DecodedFrame, produce_frame, ProjectUniforms, RenderVideoConstants};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

use crate::editor_instance::SocketMessage;

struct EditorState {
    config: ProjectConfiguration,
    playback_position: u32,
    playing: bool,
}

pub enum EditorMessage {
    SetPlaybackPosition(u32),
    TogglePlayback(bool),
    PreviewFrame(u32),
}

pub enum EditorEvent {
    PlaybackChanged(bool),
}

struct Editor {
    config: ProjectConfiguration,
    playback_position: u32,
    playing: bool,
    rx: mpsc::Receiver<EditorMessage>,
    // event_tx: mpsc::Sender<EditorEvent>,
}

struct EditorHandle {
    tx: mpsc::Sender<EditorMessage>,
}

impl Editor {
    fn new(config: ProjectConfiguration) -> EditorHandle {
        let (tx, rx) = mpsc::channel(4);

        let mut this = Self {
            config,
            playback_position: 0,
            playing: false,
            rx,
        };

        tokio::spawn(async move {
            while let Some(msg) = this.rx.recv().await {
                this.tick(msg).await;
            }
        });

        EditorHandle { tx }
    }

    async fn tick(&mut self, msg: EditorMessage) {
        match msg {
            EditorMessage::SetPlaybackPosition(position) => {
                if self.playing {
                    return;
                }

                self.playback_position = position;
            }
            EditorMessage::TogglePlayback(play) => {
                if self.playing == play {
                    return;
                }

                self.playing = play;
            }
            EditorMessage::PreviewFrame(frame_number) => if self.playing {},
        }
    }
}

impl EditorHandle {
    async fn send(&mut self, msg: EditorMessage) {
        self.tx.send(msg).await.unwrap();
    }

    pub async fn set_playback_position(&mut self, position: u32) {
        self.send(EditorMessage::SetPlaybackPosition(position))
            .await;
    }

    pub async fn start_playback(&mut self) {
        self.send(EditorMessage::TogglePlayback(true)).await;
    }

    pub async fn stop_playback(&mut self) {
        self.send(EditorMessage::TogglePlayback(false)).await;
    }
}

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
    frame_tx: mpsc::Sender<SocketMessage>,
    render_constants: Arc<RenderVideoConstants>,
}

pub struct RendererHandle {
    tx: mpsc::Sender<RendererMessage>,
}

impl Renderer {
    pub fn spawn(
        render_constants: Arc<RenderVideoConstants>,
        frame_tx: mpsc::Sender<SocketMessage>,
    ) -> RendererHandle {
        let (tx, rx) = mpsc::channel(4);

        let this = Self {
            rx,
            frame_tx,
            render_constants,
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
                        time, // Add this
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

                        frame_task = Some(tokio::spawn(async move {
                            let now = Instant::now();
                            let (frame, stride) = produce_frame(
                                &render_constants,
                                &screen_frame,
                                &camera_frame,
                                cap_rendering::Background::from(background),
                                &uniforms,
                                time, // Pass the actual time value
                            )
                            .await
                            .unwrap();

                            frame_tx
                                .try_send(SocketMessage::Frame {
                                    data: frame,
                                    width: uniforms.output_size.0,
                                    height: uniforms.output_size.1,
                                    stride,
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
