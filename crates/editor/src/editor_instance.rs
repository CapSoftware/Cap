use crate::editor;
use crate::playback::{self, PlaybackHandle};
use cap_media::feeds::AudioData;
use cap_media::frame_ws::create_frame_ws;
use cap_project::{CursorEvents, ProjectConfiguration, RecordingMeta, XY};
use cap_rendering::{
    ProjectRecordings, ProjectUniforms, RecordingSegmentDecoders, RenderOptions,
    RenderVideoConstants, SegmentVideoPaths,
};
use std::ops::Deref;
use std::sync::Mutex as StdMutex;
use std::time::Instant;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::{mpsc, watch, Mutex};

const FPS: u32 = 30;

pub struct EditorInstance {
    pub project_path: PathBuf,
    pub id: String,
    pub ws_port: u16,
    pub recordings: ProjectRecordings,
    pub renderer: Arc<editor::RendererHandle>,
    pub render_constants: Arc<RenderVideoConstants>,
    pub state: Arc<Mutex<EditorState>>,
    on_state_change: Box<dyn Fn(&EditorState) + Send + Sync + 'static>,
    pub preview_tx: watch::Sender<Option<PreviewFrameInstruction>>,
    pub project_config: (
        watch::Sender<ProjectConfiguration>,
        watch::Receiver<ProjectConfiguration>,
    ),
    ws_shutdown: Arc<StdMutex<Option<mpsc::Sender<()>>>>,
    pub segments: Arc<Vec<Segment>>,
}

impl EditorInstance {
    pub async fn new(
        projects_path: PathBuf,
        video_id: String,
        on_state_change: impl Fn(&EditorState) + Send + Sync + 'static,
    ) -> Arc<Self> {
        sentry::configure_scope(|scope| {
            scope.set_tag("crate", "editor");
        });

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
            screen_size: XY::new(
                recordings.segments[0].display.width,
                recordings.segments[0].display.height,
            ),
            camera_size: recordings.segments[0]
                .camera
                .as_ref()
                .map(|c| XY::new(c.width, c.height)),
        };

        let segments =
            match &meta.content {
                cap_project::Content::SingleSegment { segment: s } => {
                    let audio =
                        Arc::new(s.audio.as_ref().map(|meta| {
                            AudioData::from_file(project_path.join(&meta.path)).unwrap()
                        }));

                    let cursor = Arc::new(s.cursor_data(&meta).into());

                    let decoders = RecordingSegmentDecoders::new(
                        &meta,
                        SegmentVideoPaths {
                            display: s.display.path.as_path(),
                            camera: s.camera.as_ref().map(|c| c.path.as_path()),
                        },
                    );

                    vec![Segment {
                        audio,
                        cursor,
                        decoders,
                    }]
                }
                cap_project::Content::MultipleSegments { inner } => {
                    let mut segments = vec![];

                    for s in &inner.segments {
                        let audio = Arc::new(s.audio.as_ref().map(|meta| {
                            AudioData::from_file(project_path.join(&meta.path)).unwrap()
                        }));

                        let cursor = Arc::new(s.cursor_events(&meta));

                        let decoders = RecordingSegmentDecoders::new(
                            &meta,
                            SegmentVideoPaths {
                                display: s.display.path.as_path(),
                                camera: s.camera.as_ref().map(|c| c.path.as_path()),
                            },
                        );

                        segments.push(Segment {
                            audio,
                            cursor,
                            decoders,
                        });
                    }

                    segments
                }
            };

        let (frame_tx, frame_rx) = flume::bounded(4);

        let (ws_port, ws_shutdown) = create_frame_ws(frame_rx).await;

        let render_constants = Arc::new(
            RenderVideoConstants::new(render_options, &meta)
                .await
                .unwrap(),
        );

        let renderer = Arc::new(editor::Renderer::spawn(render_constants.clone(), frame_tx));

        let (preview_tx, preview_rx) = watch::channel(None);

        let this = Arc::new(Self {
            id: video_id,
            project_path,
            recordings,
            ws_port,
            renderer,
            render_constants,
            state: Arc::new(Mutex::new(EditorState {
                playhead_position: 0,
                playback_task: None,
                preview_task: None,
            })),
            on_state_change: Box::new(on_state_change),
            preview_tx,
            project_config: watch::channel(meta.project_config()),
            ws_shutdown: Arc::new(StdMutex::new(Some(ws_shutdown))),
            segments: Arc::new(segments),
        });

        this.state.lock().await.preview_task =
            Some(this.clone().spawn_preview_renderer(preview_rx));

        this
    }

    pub fn meta(&self) -> RecordingMeta {
        RecordingMeta::load_for_project(&self.project_path).unwrap()
    }

    pub async fn dispose(&self) {
        println!("Disposing EditorInstance");

        let mut state = self.state.lock().await;

        // Stop playback
        if let Some(handle) = state.playback_task.take() {
            println!("Stopping playback");
            handle.stop();
        }

        // Stop preview
        if let Some(task) = state.preview_task.take() {
            println!("Stopping preview");
            task.abort();
            task.await.ok(); // Await the task to ensure it's fully stopped
        }

        // Stop WebSocket server
        if let Some(ws_shutdown) = self.ws_shutdown.lock().unwrap().take() {
            println!("Shutting down WebSocket server");
            let _ = ws_shutdown.send(());
        }

        // Stop renderer
        println!("Stopping renderer");
        self.renderer.stop().await;

        // // Clear audio data
        // if self.audio.lock().unwrap().is_some() {
        //     println!("Clearing audio data");
        //     *self.audio.lock().unwrap() = None; // Explicitly drop the audio data
        // }

        // Cancel any remaining tasks
        tokio::task::yield_now().await;

        drop(state);

        println!("EditorInstance disposed");
    }

    pub async fn modify_and_emit_state(&self, modify: impl Fn(&mut EditorState)) {
        let mut state = self.state.lock().await;
        modify(&mut state);
        (self.on_state_change)(&state);
    }

    pub async fn start_playback(self: Arc<Self>) {
        let (mut handle, prev) = {
            let Ok(mut state) = self.state.try_lock() else {
                return;
            };

            let start_frame_number = state.playhead_position;

            let playback_handle = playback::Playback {
                segments: self.segments.clone(),
                renderer: self.renderer.clone(),
                render_constants: self.render_constants.clone(),
                start_frame_number,
                project: self.project_config.0.subscribe(),
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
                        // ! This editor instance (self) gets dropped here
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
        mut preview_rx: watch::Receiver<Option<u32>>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                preview_rx.changed().await.unwrap();
                let Some(frame_number) = *preview_rx.borrow().deref() else {
                    continue;
                };

                let project = self.project_config.1.borrow().clone();

                let now = Instant::now();

                let Some((time, segment)) = project
                    .timeline
                    .as_ref()
                    .map(|timeline| timeline.get_recording_time(frame_number as f64 / FPS as f64))
                    .unwrap_or(Some((frame_number as f64 / FPS as f64, None)))
                else {
                    continue;
                };

                let segment = &self.segments[segment.unwrap_or(0) as usize];

                let now = Instant::now();

                let Some((screen_frame, camera_frame)) = segment
                    .decoders
                    .get_frames((time * FPS as f64) as u32)
                    .await
                else {
                    continue;
                };

                self.renderer
                    .render_frame(
                        screen_frame,
                        camera_frame,
                        project.background.source.clone(),
                        ProjectUniforms::new(&self.render_constants, &project, time as f32),
                        time as f32, // Add the time parameter
                    )
                    .await;
            }
        })
    }
}

impl Drop for EditorInstance {
    fn drop(&mut self) {
        // TODO: Ensure that *all* resources have been released by this point?
        // For now the `dispose` method is adequate.
        println!("*** Editor instance {} has been released. ***", self.id);
    }
}

// async fn create_frames_ws(frame_rx: mpsc::Receiver<SocketMessage>) -> (u16, mpsc::Sender<()>) {
//     use axum::{
//         extract::{
//             ws::{Message, WebSocket, WebSocketUpgrade},
//             State,
//         },
//         response::IntoResponse,
//         routing::get,
//     };
//     use tokio::sync::{mpsc::Receiver, Mutex};

//     type RouterState = Arc<Mutex<Receiver<SocketMessage>>>;

//     async fn ws_handler(
//         ws: WebSocketUpgrade,
//         State(state): State<RouterState>,
//     ) -> impl IntoResponse {
//         // let rx = rx.lock().await.take().unwrap();
//         ws.on_upgrade(move |socket| handle_socket(socket, state))
//     }

//     async fn handle_socket(mut socket: WebSocket, state: RouterState) {
//         let mut rx = state.lock().await;
//         println!("socket connection established");
//         let now = std::time::Instant::now();

//         loop {
//             tokio::select! {
//                 _ = socket.recv() => {
//                     break;
//                 }
//                 msg = rx.recv() => {
//                     let Some(chunk) = msg else {
//                         continue;
//                     };

//                     match chunk {
//                         SocketMessage::Frame { width, height, mut data, stride } => {
//                             data.extend_from_slice(&stride.to_le_bytes());
//                             data.extend_from_slice(&height.to_le_bytes());
//                             data.extend_from_slice(&width.to_le_bytes());

//                             socket.send(Message::Binary(data)).await.unwrap();
//                         }
//                     }
//                 }
//             }
//         }
//         let elapsed = now.elapsed();
//         println!("Websocket closing after {elapsed:.2?}");
//     }

//     let router = axum::Router::new()
//         .route(FRAMES_WS_PATH, get(ws_handler))
//         .with_state(Arc::new(Mutex::new(frame_rx)));

//     let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
//     let port = listener.local_addr().unwrap().port();

//     let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

//     tokio::spawn(async move {
//         let server = axum::serve(listener, router.into_make_service());
//         tokio::select! {
//             _ = server => {},
//             _ = shutdown_rx.recv() => {
//                 println!("WebSocket server shutting down");
//             }
//         }
//     });

//     (port, shutdown_tx)
// }

type PreviewFrameInstruction = u32;

pub struct EditorState {
    pub playhead_position: u32,
    pub playback_task: Option<PlaybackHandle>,
    pub preview_task: Option<tokio::task::JoinHandle<()>>,
}

pub struct Segment {
    pub audio: Arc<Option<AudioData>>,
    pub cursor: Arc<CursorEvents>,
    pub decoders: RecordingSegmentDecoders,
}
