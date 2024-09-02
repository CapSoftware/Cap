use std::sync::Arc;

use cap_project::ProjectConfiguration;
use cap_rendering::{produce_frame, RenderVideoConstants};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

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
            EditorMessage::PreviewFrame(frame_number) => {
                if self.playing {
                }
            }
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
        screen_frame: Vec<u8>,
        camera_frame: Option<Vec<u8>>,
        screen_uniforms_buffer: wgpu::Buffer,
        camera_uniforms_buffer: Option<wgpu::Buffer>,
        composite_uniforms_buffer: wgpu::Buffer,
        finished: oneshot::Sender<()>,
    },
}

pub struct Renderer {
    rx: mpsc::Receiver<RendererMessage>,
    frame_tx: mpsc::UnboundedSender<Vec<u8>>,
    render_constants: Arc<RenderVideoConstants>,
}

pub struct RendererHandle {
    tx: mpsc::Sender<RendererMessage>,
}

impl Renderer {
    pub fn spawn(
        render_constants: Arc<RenderVideoConstants>,
        frame_tx: mpsc::UnboundedSender<Vec<u8>>,
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
                        screen_uniforms_buffer,
                        camera_uniforms_buffer,
                        composite_uniforms_buffer,
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
                            let frame = produce_frame(
                                &render_constants,
                                &screen_uniforms_buffer,
                                &screen_frame,
                                camera_uniforms_buffer.as_ref(),
                                camera_frame.as_ref(),
                                &composite_uniforms_buffer,
                            )
                            .await
                            .unwrap();

                            frame_tx.send(frame).ok();
                            finished.send(()).ok();
                        }));
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
        screen_frame: Vec<u8>,
        camera_frame: Option<Vec<u8>>,
        screen_uniforms_buffer: wgpu::Buffer,
        camera_uniforms_buffer: Option<wgpu::Buffer>,
        composite_uniforms_buffer: wgpu::Buffer,
    ) {
        let (finished_tx, finished_rx) = oneshot::channel();

        self.send(RendererMessage::RenderFrame {
            screen_frame,
            camera_frame,
            screen_uniforms_buffer,
            camera_uniforms_buffer,
            composite_uniforms_buffer,
            finished: finished_tx,
        })
        .await;

        finished_rx.await.ok();
    }
}
