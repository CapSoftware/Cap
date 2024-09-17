use crate::display::FPS;
use crate::playback::{self, PlaybackHandle};
use crate::project_recordings::ProjectRecordings;
use crate::{editor, AudioData};
use cap_ffmpeg::FFmpeg;
use cap_project::{ProjectConfiguration, RecordingMeta};
use cap_rendering::decoder::AsyncVideoDecoder;
use cap_rendering::{ProjectUniforms, RecordingDecoders, RenderOptions, RenderVideoConstants};
use std::ops::Deref;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::{mpsc, watch, Mutex};

type PreviewFrameInstruction = (u32, ProjectConfiguration);

pub struct EditorState {
    pub playhead_position: u32,
    pub playback_task: Option<PlaybackHandle>,
    pub preview_task: Option<tokio::task::JoinHandle<()>>,
}

pub struct EditorInstance {
    pub project_path: PathBuf,
    pub id: String,
    pub audio: Option<AudioData>,
    pub ws_port: u16,
    pub decoders: RecordingDecoders,
    pub recordings: ProjectRecordings,
    pub renderer: Arc<editor::RendererHandle>,
    pub render_constants: Arc<RenderVideoConstants>,
    pub state: Mutex<EditorState>,
    on_state_change: Box<dyn Fn(&EditorState) + Send + Sync + 'static>,
    pub preview_tx: watch::Sender<Option<PreviewFrameInstruction>>,
}

impl EditorInstance {
    pub async fn new(
        projects_path: PathBuf,
        video_id: String,
        on_state_change: impl Fn(&EditorState) + Send + Sync + 'static,
    ) -> Arc<Self> {
        let project_path = projects_path.join(format!(
            "{}{}",
            video_id,
            if video_id.ends_with(".cap") {
                ""
            } else {
                ".cap"
            }
        ));

        if !project_path.exists() {
            println!("Video path {} not found!", project_path.display());
            // return Err(format!("Video path {} not found!", path.display()));
            panic!("Video path {} not found!", project_path.display());
        }

        let meta = cap_project::RecordingMeta::load_for_project(&project_path).unwrap();

        let recordings = ProjectRecordings::new(&meta);

        let render_options = RenderOptions {
            screen_size: (recordings.display.width, recordings.display.height),
            camera_size: recordings.camera.as_ref().map(|c| (c.width, c.height)),
        };

        let screen_decoder =
            AsyncVideoDecoder::spawn(project_path.join(&meta.display.path).clone());
        let camera_decoder = meta
            .camera
            .as_ref()
            .map(|camera| AsyncVideoDecoder::spawn(project_path.join(&camera.path).clone()));

        let audio = meta
            .audio
            .as_ref()
            .zip(recordings.audio)
            .map(|(meta, recording)| {
                let audio_path = project_path.join(&meta.path);

                // TODO: Use ffmpeg crate instead of command line
                let stdout = FFmpeg::new()
                    .command
                    .arg("-i")
                    .arg(audio_path)
                    .args(["-f", "f64le", "-acodec", "pcm_f64le"])
                    .args(["-ar", &recording.sample_rate.to_string()])
                    .args(["-ac", &recording.channels.to_string(), "-"])
                    .output()
                    .unwrap()
                    .stdout;

                let buffer = stdout
                    .chunks_exact(8)
                    .map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]))
                    .collect::<Vec<_>>();

                println!("audio buffer length: {}", buffer.len());

                AudioData {
                    buffer: Arc::new(buffer),
                    sample_rate: recording.sample_rate,
                }
            });

        let (frame_tx, frame_rx) = tokio::sync::mpsc::unbounded_channel();

        let ws_port = create_frames_ws(frame_rx).await;

        let render_constants = Arc::new(RenderVideoConstants::new(render_options).await.unwrap());

        let renderer = Arc::new(editor::Renderer::spawn(render_constants.clone(), frame_tx));

        let (preview_tx, preview_rx) = watch::channel(None);

        let this = Arc::new(Self {
            id: video_id,
            project_path,
            decoders: RecordingDecoders::new(screen_decoder, camera_decoder),
            recordings,
            ws_port,
            renderer,
            render_constants,
            audio,
            state: Mutex::new(EditorState {
                playhead_position: 0,
                playback_task: None,
                preview_task: None,
            }),
            on_state_change: Box::new(on_state_change),
            preview_tx,
        });

        this.state.lock().await.preview_task =
            Some(this.clone().spawn_preview_renderer(preview_rx));

        this
    }

    pub fn meta(&self) -> RecordingMeta {
        RecordingMeta::load_for_project(&self.project_path).unwrap()
    }

    pub async fn dispose(&self) {
        let mut state = self.state.lock().await;
        println!("got state");
        if let Some(handle) = state.playback_task.take() {
            println!("stopping playback");
            handle.stop();
        };
        if let Some(task) = state.preview_task.take() {
            println!("stopping preview");
            task.abort();
        }
    }

    pub async fn modify_and_emit_state(&self, modify: impl Fn(&mut EditorState)) {
        let mut state = self.state.lock().await;
        modify(&mut state);
        (self.on_state_change)(&state);
    }

    pub async fn start_playback(self: Arc<Self>, project: ProjectConfiguration) {
        let (mut handle, prev) = {
            let Ok(mut state) = self.state.try_lock() else {
                return;
            };

            let start_frame_number = state.playhead_position;

            let playback_handle = playback::Playback {
                audio: self.audio.clone(),
                renderer: self.renderer.clone(),
                render_constants: self.render_constants.clone(),
                decoders: self.decoders.clone(),
                recordings: self.recordings,
                start_frame_number,
                project,
            }
            .start()
            .await;

            let prev = state.playback_task.replace(playback_handle.clone());

            (playback_handle, prev)
        };

        tokio::spawn(async move {
            loop {
                let event = *handle.receive_event().await;

                match event {
                    playback::PlaybackEvent::Start => {}
                    playback::PlaybackEvent::Frame(frame_number) => {
                        self.modify_and_emit_state(|state| {
                            state.playhead_position = frame_number;
                        })
                        .await;
                    }
                    playback::PlaybackEvent::Stop => {
                        return;
                    }
                }
            }
        });

        if let Some(prev) = prev {
            prev.stop();
        }
    }

    fn spawn_preview_renderer(
        self: Arc<Self>,
        mut preview_rx: watch::Receiver<Option<PreviewFrameInstruction>>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                preview_rx.changed().await.unwrap();
                let Some((frame_number, project)) = preview_rx.borrow().deref().clone() else {
                    continue;
                };

                let Some(time) = project.timeline.as_ref().map(|timeline| {
                    timeline.get_recording_time(frame_number as f64 / FPS as f64)
                }).unwrap_or(Some(frame_number as f64 / FPS as f64)) else {
                    continue;
                };

                let Some((screen_frame, camera_frame)) =
                    self.decoders.get_frames((time * FPS as f64) as u32).await
                else {
                    continue;
                };

                self.renderer
                    .render_frame(
                        screen_frame,
                        camera_frame,
                        project.background.source.clone(),
                        ProjectUniforms::new(&self.render_constants, &project),
                    )
                    .await;
            }
        })
    }
}

pub const FRAMES_WS_PATH: &str = "/frames-ws";

pub enum SocketMessage {
    Frame {
        data: Vec<u8>,
        width: u32,
        height: u32,
    },
}

async fn create_frames_ws(frame_rx: mpsc::UnboundedReceiver<SocketMessage>) -> u16 {
    use axum::{
        extract::{
            ws::{Message, WebSocket, WebSocketUpgrade},
            State,
        },
        response::IntoResponse,
        routing::get,
    };
    use tokio::sync::{mpsc::UnboundedReceiver, Mutex};

    type RouterState = Arc<Mutex<UnboundedReceiver<SocketMessage>>>;

    async fn ws_handler(
        ws: WebSocketUpgrade,
        State(state): State<RouterState>,
    ) -> impl IntoResponse {
        // let rx = rx.lock().await.take().unwrap();
        ws.on_upgrade(move |socket| handle_socket(socket, state))
    }

    async fn handle_socket(mut socket: WebSocket, state: RouterState) {
        let mut rx = state.lock().await;
        println!("socket connection established");
        let now = std::time::Instant::now();

        loop {
            tokio::select! {
                _ = socket.recv() => {
                    break;
                }
                msg = rx.recv() => {
                    let Some(chunk) = msg else {
                        continue;
                    };

                    match chunk {
                        SocketMessage::Frame { width, height, mut data } => {
                                data.extend_from_slice(&height.to_le_bytes());
                              data.extend_from_slice(&width.to_le_bytes());

                            socket.send(Message::Binary(data)).await.unwrap();
                        }
                    }
                }
            }
        }
        let elapsed = now.elapsed();
        println!("Websocket closing after {elapsed:.2?}");
    }

    let router = axum::Router::new()
        .route(FRAMES_WS_PATH, get(ws_handler))
        .with_state(Arc::new(Mutex::new(frame_rx)));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service())
            .await
            .unwrap();
    });

    port
}
