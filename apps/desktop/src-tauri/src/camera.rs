use serde::Serialize;
use specta::Type;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::{oneshot, watch};

use tauri::{AppHandle, Manager, WebviewUrl};

use crate::{
    capture::CaptureController,
    encoder::{uyvy422_frame, H264Encoder},
};

#[tauri::command(async)]
#[specta::specta]
pub fn list_cameras() -> Vec<String> {
    nokhwa::query(nokhwa::utils::ApiBackend::Auto)
        .unwrap()
        .into_iter()
        .map(|i| i.human_name().to_string())
        .collect()
}

pub fn find_camera_by_label(label: &str) -> Option<nokhwa::utils::CameraInfo> {
    nokhwa::query(nokhwa::utils::ApiBackend::Auto)
        .unwrap()
        .into_iter()
        .find(|c| &c.human_name() == label)
}

#[derive(Serialize, Type)]
pub struct CameraInfo {
    pub human_name: String,
    pub description: String,
}

// ffmpeg
//     .command
//     .args(["-f", "mp4", "-map", &format!("{}:v", ffmpeg_input.index)])
//     .args(["-codec:v", "libx264", "-preset", "ultrafast"])
//     .args(["-pix_fmt", "yuv420p", "-tune", "zerolatency"])
//     .args(["-vsync", "1", "-force_key_frames", "expr:gte(t,n_forced*3)"])
//     .args(["-movflags", "frag_keyframe+empty_moov"])
//     .args(["-g", &keyframe_interval_str])
//     .args(["-keyint_min", &keyframe_interval_str])
//     .args([
//         "-vf",
//         &format!(
//             "fps={},scale=in_range=full:out_range=limited",
//             ffmpeg_input.fps
//         ),
//     ])
//     .arg(&output_path);

pub async fn start_capturing(
    output_path: PathBuf,
    camera_feed: &CameraFeed,
    mut start_writing_rx: watch::Receiver<bool>,
) -> CaptureController {
    let controller = CaptureController::new(output_path);

    let (start_tx, start_rx) = oneshot::channel();

    let handle = tokio::runtime::Handle::current();
    let mut frames_rx = camera_feed.frame_rx.clone();
    let format = camera_feed.camera_format.clone();

    std::thread::spawn({
        let controller = controller.clone();
        move || {
            let mut encoder = H264Encoder::new(
                &controller.output_path,
                format.resolution().width(),
                format.resolution().height(),
                30.0,
            );

            let mut start_tx = Some(start_tx);

            let mut scaler = ffmpeg::software::converter(
                (format.resolution().width(), format.resolution().height()),
                nokhwa_format_to_ffmpeg(format.format()),
                H264Encoder::output_format(),
            )
            .unwrap();

            let mut last_frame_time = Instant::now();
            let frame_duration = Duration::from_secs_f64(1.0 / 30.0);

            loop {
                if controller.is_stopped() {
                    println!("Stopping receiving camera frames");
                    break;
                }

                // Use a non-blocking approach to check for changes
                if frames_rx.has_changed().unwrap_or(false) {
                    let frame = frames_rx.borrow_and_update();
                    let Some((frame, timestamp)) = frame.as_ref() else {
                        continue;
                    };

                    if controller.is_paused() {
                        continue;
                    }

                    if let Some(start_tx) = start_tx.take() {
                        start_tx.send(Instant::now()).unwrap();
                    }

                    if !*start_writing_rx.borrow_and_update() {
                        continue;
                    }

                    let now = Instant::now();
                    if now.duration_since(last_frame_time) < frame_duration {
                        std::thread::sleep(frame_duration - now.duration_since(last_frame_time));
                    }
                    last_frame_time = Instant::now();

                    let yuyv422_frame = uyvy422_frame(
                        frame.buffer(),
                        frame.resolution().width(),
                        frame.resolution().height(),
                    );

                    let mut yuv_frame = ffmpeg::util::frame::Video::empty();
                    if let Err(e) = scaler.run(&yuyv422_frame, &mut yuv_frame) {
                        eprintln!("Error scaling frame: {:?}", e);
                        continue;
                    }

                    encoder.encode_frame(
                        yuv_frame,
                        timestamp
                            .duration_since(SystemTime::UNIX_EPOCH)
                            .unwrap()
                            .as_millis() as u64,
                    );
                } else {
                    // If no new frame, sleep for a short duration to avoid busy-waiting
                    std::thread::sleep(Duration::from_millis(1));
                }
            }

            encoder.close();
        }
    });

    start_rx.await.unwrap(); // wait for first frame

    controller
}

fn nokhwa_format_to_ffmpeg(nokhwa_format: nokhwa::utils::FrameFormat) -> ffmpeg::format::Pixel {
    match nokhwa_format {
        nokhwa::utils::FrameFormat::YUYV => ffmpeg::format::Pixel::UYVY422,
        _ => todo!(),
    }
}

type CameraFrame = (nokhwa::Buffer, SystemTime);

pub async fn create_camera_ws(frame_rx: watch::Receiver<Option<CameraFrame>>) -> u16 {
    use axum::{
        extract::{
            ws::{Message, WebSocket, WebSocketUpgrade},
            State,
        },
        response::IntoResponse,
        routing::get,
    };
    use tokio::sync::Mutex;

    type RouterState = Arc<Mutex<watch::Receiver<Option<CameraFrame>>>>;

    async fn ws_handler(
        ws: WebSocketUpgrade,
        State(state): State<RouterState>,
    ) -> impl IntoResponse {
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
                _ = rx.changed() => {
                    let data = {
                        let msg = rx.borrow_and_update();

                        let Some((buffer, _)) = msg.as_ref() else {
                            continue;
                        };

                        let source_fmt = nokhwa_format_to_ffmpeg(buffer.source_frame_format());
                        let out_fmt = ffmpeg::format::Pixel::RGBA;

                        let out_size = (buffer.resolution().width(), buffer.resolution().height());

                        let mut scaler = ffmpeg::software::converter(
                            (buffer.resolution().width(), buffer.resolution().height()),
                            source_fmt,
                            out_fmt,
                        )
                        .unwrap();

                        let uyvy422_frame = uyvy422_frame(
                            buffer.buffer(),
                            buffer.resolution().width(),
                            buffer.resolution().height(),
                        );

                        let mut frame = ffmpeg::frame::Video::empty();
                        scaler.run(&uyvy422_frame, &mut frame).unwrap();

                        let mut data = frame.data(0).to_vec();

                        let height_bytes: [u8; 4] = out_size.1.to_le_bytes();
                        data.extend_from_slice(height_bytes.as_slice());
                        let width_bytes: [u8; 4] = out_size.0.to_le_bytes();
                        data.extend_from_slice(width_bytes.as_slice());

                        data
                    };

                    socket.send(Message::Binary(data)).await.unwrap();
                }
            }
        }
        let elapsed = now.elapsed();
        println!("Websocket closing after {elapsed:.2?}");
    }

    let router = axum::Router::new()
        .route("/", get(ws_handler))
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

pub type LatestFrame = Option<(nokhwa::Buffer, SystemTime)>;

pub struct CameraFeed {
    pub camera_info: nokhwa::utils::CameraInfo,
    pub camera_format: nokhwa::utils::CameraFormat,
    pub frame_rx: watch::Receiver<LatestFrame>,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

impl CameraFeed {
    pub async fn new(label: &str, frame_tx: watch::Sender<LatestFrame>) -> Self {
        let camera_info = find_camera_by_label(&label).unwrap();

        use nokhwa::{pixel_format::*, utils::*, *};

        let format =
            RequestedFormat::new::<RgbFormat>(RequestedFormatType::Closest(CameraFormat::new(
                Resolution {
                    width_x: 1920,
                    height_y: 1080,
                },
                FrameFormat::YUYV,
                30,
            )));

        let (shutdown_tx, mut shutdown_rx) = oneshot::channel();

        let (setup_tx, setup_rx) = oneshot::channel();

        let frame_rx = frame_tx.subscribe();

        std::thread::spawn({
            let camera_info = camera_info.clone();
            move || {
                let mut camera = Camera::new(camera_info.index().clone(), format).unwrap();

                camera.open_stream().unwrap();

                setup_tx.send(camera.camera_format()).unwrap();

                loop {
                    if shutdown_rx.try_recv().is_ok() {
                        return;
                    }

                    let frame = camera.frame().unwrap();
                    let timestamp = SystemTime::now();

                    frame_tx.send(Some((frame, timestamp))).unwrap();
                }
            }
        });

        let camera_format = setup_rx.await.unwrap();

        Self {
            camera_info,
            camera_format,
            frame_rx,
            shutdown_tx: Some(shutdown_tx),
        }
    }
}

impl Drop for CameraFeed {
    fn drop(&mut self) {
        self.shutdown_tx.take().unwrap().send(()).unwrap();
    }
}
