use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Instant;
use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;

static TOTAL_BYTES_SENT: AtomicU64 = AtomicU64::new(0);
static TOTAL_FRAMES_SENT: AtomicU32 = AtomicU32::new(0);
static LAST_LOG_TIME: AtomicU64 = AtomicU64::new(0);

const NV12_FORMAT_MAGIC: u32 = 0x4e563132;

fn convert_to_nv12(data: &[u8], width: u32, height: u32, stride: u32) -> Vec<u8> {
    let width = (width & !1) as usize;
    let height = (height & !1) as usize;

    if width == 0 || height == 0 {
        return Vec::new();
    }

    let y_size = width * height;
    let uv_size = width * (height / 2);
    let stride = stride as usize;

    let mut output = vec![0u8; y_size + uv_size];
    let (y_plane, uv_plane) = output.split_at_mut(y_size);

    for row in 0..height {
        let src_offset = row * stride;
        let y_offset = row * width;

        if src_offset + width * 4 > data.len() {
            continue;
        }

        let src_row = &data[src_offset..];
        let y_row = &mut y_plane[y_offset..y_offset + width];

        for x in 0..width {
            let px = x * 4;
            let r = src_row[px] as i32;
            let g = src_row[px + 1] as i32;
            let b = src_row[px + 2] as i32;
            y_row[x] = (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16).min(255) as u8;
        }

        if row % 2 == 0 {
            let uv_offset = (row / 2) * width;
            let uv_row = &mut uv_plane[uv_offset..uv_offset + width];

            let mut x = 0;
            while x < width {
                let px0 = x * 4;
                let px1 = (x + 1) * 4;

                let r0 = src_row[px0] as i32;
                let g0 = src_row[px0 + 1] as i32;
                let b0 = src_row[px0 + 2] as i32;
                let r1 = src_row[px1] as i32;
                let g1 = src_row[px1 + 1] as i32;
                let b1 = src_row[px1 + 2] as i32;

                let avg_r = (r0 + r1) >> 1;
                let avg_g = (g0 + g1) >> 1;
                let avg_b = (b0 + b1) >> 1;

                uv_row[x] = (((-38 * avg_r - 74 * avg_g + 112 * avg_b + 128) >> 8) + 128)
                    .clamp(0, 255) as u8;
                uv_row[x + 1] = (((112 * avg_r - 94 * avg_g - 18 * avg_b + 128) >> 8) + 128)
                    .clamp(0, 255) as u8;

                x += 2;
            }
        }
    }

    output
}

fn pack_nv12_frame(
    data: Vec<u8>,
    width: u32,
    height: u32,
    frame_number: u32,
    target_time_ns: u64,
) -> Vec<u8> {
    let y_stride = width;
    let metadata_size = 28;
    let mut output = Vec::with_capacity(data.len() + metadata_size);
    output.extend_from_slice(&data);
    output.extend_from_slice(&y_stride.to_le_bytes());
    output.extend_from_slice(&height.to_le_bytes());
    output.extend_from_slice(&width.to_le_bytes());
    output.extend_from_slice(&frame_number.to_le_bytes());
    output.extend_from_slice(&target_time_ns.to_le_bytes());
    output.extend_from_slice(&NV12_FORMAT_MAGIC.to_le_bytes());

    output
}

fn pack_frame_data(
    mut data: Vec<u8>,
    stride: u32,
    height: u32,
    width: u32,
    frame_number: u32,
    target_time_ns: u64,
) -> Vec<u8> {
    data.reserve_exact(24);
    data.extend_from_slice(&stride.to_le_bytes());
    data.extend_from_slice(&height.to_le_bytes());
    data.extend_from_slice(&width.to_le_bytes());
    data.extend_from_slice(&frame_number.to_le_bytes());
    data.extend_from_slice(&target_time_ns.to_le_bytes());
    data
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum WSFrameFormat {
    Rgba,
    Nv12,
}

#[derive(Clone)]
pub struct WSFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub frame_number: u32,
    pub target_time_ns: u64,
    pub format: WSFrameFormat,
    #[allow(dead_code)]
    pub created_at: Instant,
}

impl WSFrame {
    pub fn from_rendered_frame_nv12(
        data: Vec<u8>,
        width: u32,
        height: u32,
        stride: u32,
        frame_number: u32,
        target_time_ns: u64,
    ) -> Self {
        let nv12_data = convert_to_nv12(&data, width, height, stride);
        Self {
            data: nv12_data,
            width: width & !1,
            height: height & !1,
            stride: width & !1,
            frame_number,
            target_time_ns,
            format: WSFrameFormat::Nv12,
            created_at: Instant::now(),
        }
    }
}

fn pack_ws_frame(frame: WSFrame) -> Vec<u8> {
    match frame.format {
        WSFrameFormat::Nv12 => pack_nv12_frame(
            frame.data,
            frame.width,
            frame.height,
            frame.frame_number,
            frame.target_time_ns,
        ),
        WSFrameFormat::Rgba => pack_frame_data(
            frame.data,
            frame.stride,
            frame.height,
            frame.width,
            frame.frame_number,
            frame.target_time_ns,
        ),
    }
}

pub async fn create_watch_frame_ws(
    frame_rx: watch::Receiver<Option<WSFrame>>,
) -> (u16, CancellationToken) {
    use axum::{
        extract::{
            State,
            ws::{Message, WebSocket, WebSocketUpgrade},
        },
        response::IntoResponse,
        routing::get,
    };

    type RouterState = watch::Receiver<Option<WSFrame>>;

    #[axum::debug_handler]
    async fn ws_handler(
        ws: WebSocketUpgrade,
        State(state): State<RouterState>,
    ) -> impl IntoResponse {
        ws.on_upgrade(move |socket| handle_socket(socket, state))
    }

    async fn handle_socket(mut socket: WebSocket, mut camera_rx: watch::Receiver<Option<WSFrame>>) {
        tracing::info!("Socket connection established");
        let now = std::time::Instant::now();

        {
            let frame_opt = camera_rx.borrow().clone();
            if let Some(frame) = frame_opt {
                let packed = pack_ws_frame(frame);

                if let Err(e) = socket.send(Message::Binary(packed)).await {
                    tracing::error!("Failed to send initial frame to socket: {:?}", e);
                    return;
                }
            }
        }

        loop {
            tokio::select! {
                msg = socket.recv() => {
                    match msg {
                        Some(Ok(Message::Close(_))) | None => {
                            tracing::info!("WebSocket closed");
                            break;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(e)) => {
                            tracing::error!("WebSocket error: {:?}", e);
                            break;
                        }
                    }
                },
                _ = camera_rx.changed() => {
                    let frame_opt = camera_rx.borrow_and_update().clone();
                    if let Some(frame) = frame_opt {
                        let width = frame.width;
                        let height = frame.height;
                        let format_label = match frame.format {
                            WSFrameFormat::Nv12 => "NV12",
                            WSFrameFormat::Rgba => "RGBA",
                        };

                        let packed = pack_ws_frame(frame);
                        let packed_len = packed.len();

                        match socket.send(Message::Binary(packed)).await {
                            Ok(()) => {
                                TOTAL_BYTES_SENT.fetch_add(packed_len as u64, Ordering::Relaxed);
                                TOTAL_FRAMES_SENT.fetch_add(1, Ordering::Relaxed);
                                let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
                                let last_log = LAST_LOG_TIME.load(Ordering::Relaxed);
                                if now_ms - last_log > 2000 {
                                    LAST_LOG_TIME.store(now_ms, Ordering::Relaxed);
                                    let total_bytes = TOTAL_BYTES_SENT.swap(0, Ordering::Relaxed);
                                    let total_frames = TOTAL_FRAMES_SENT.swap(0, Ordering::Relaxed);
                                    let mb_per_sec = total_bytes as f64 / 1_000_000.0 / 2.0;
                                    tracing::info!(
                                        fps = total_frames / 2,
                                        mb_per_sec = format!("{:.1}", mb_per_sec),
                                        avg_kb = format!("{:.1}", (total_bytes as f64 / total_frames.max(1) as f64) / 1024.0),
                                        dims = format!("{}x{}", width, height),
                                        format = format_label,
                                        "WS frame stats"
                                    );
                                }
                            }
                            Err(e) => {
                                tracing::error!("Failed to send frame to socket: {:?}", e);
                                break;
                            }
                        }
                    }
                }
            }
        }

        let elapsed = now.elapsed();
        tracing::info!("Websocket closing after {elapsed:.2?}");
    }

    let router = axum::Router::new()
        .route("/", get(ws_handler))
        .with_state(frame_rx);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tracing::info!("WebSocket server listening on port {}", port);

    let cancel_token = CancellationToken::new();
    let cancel_token_child = cancel_token.child_token();
    tokio::spawn(async move {
        let server = axum::serve(listener, router.into_make_service());
        tokio::select! {
            _ = server => {},
            _ = cancel_token.cancelled() => {
                println!("WebSocket server shutting down");
            }
        }
    });

    (port, cancel_token_child)
}

pub async fn create_frame_ws(frame_tx: broadcast::Sender<WSFrame>) -> (u16, CancellationToken) {
    use axum::{
        extract::{
            State,
            ws::{Message, WebSocket, WebSocketUpgrade},
        },
        response::IntoResponse,
        routing::get,
    };

    type RouterState = broadcast::Sender<WSFrame>;

    #[axum::debug_handler]
    async fn ws_handler(
        ws: WebSocketUpgrade,
        State(state): State<RouterState>,
    ) -> impl IntoResponse {
        let rx = state.subscribe();
        ws.on_upgrade(move |socket| handle_socket(socket, rx))
    }

    async fn handle_socket(mut socket: WebSocket, mut camera_rx: broadcast::Receiver<WSFrame>) {
        println!("socket connection established");
        tracing::info!("Socket connection established");
        let now = std::time::Instant::now();

        loop {
            tokio::select! {
                msg = socket.recv() => {
                    match msg {
                        Some(Ok(Message::Close(_))) | None => {
                            tracing::info!("WebSocket closed");
                            break;
                        }
                        Some(Ok(_)) => {
                             tracing::info!("Received message from socket (ignoring)");
                        }
                        Some(Err(e)) => {
                            tracing::error!("WebSocket error: {:?}", e);
                            break;
                        }
                    }
                },
                incoming_frame = camera_rx.recv() => {
                    match incoming_frame {
                        Ok(frame) => {
                            let packed = pack_frame_data(
                                frame.data,
                                frame.stride,
                                frame.height,
                                frame.width,
                                frame.frame_number,
                                frame.target_time_ns,
                            );

                            if let Err(e) = socket.send(Message::Binary(packed)).await {
                                tracing::error!("Failed to send frame to socket: {:?}", e);
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            tracing::error!(
                                "Connection has been lost! Shutting down websocket server"
                            );
                            break;
                        }
                        Err(broadcast::error::RecvError::Lagged(_skipped)) => {
                            continue;
                        }
                    }
                }
            }
        }

        let elapsed = now.elapsed();
        println!("Websocket closing after {elapsed:.2?}");
        tracing::info!("Websocket closing after {elapsed:.2?}");
    }

    let router = axum::Router::new()
        .route("/", get(ws_handler))
        .with_state(frame_tx);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tracing::info!("WebSocket server listening on port {}", port);

    let cancel_token = CancellationToken::new();
    let cancel_token_child = cancel_token.child_token();
    tokio::spawn(async move {
        let server = axum::serve(listener, router.into_make_service());
        tokio::select! {
            _ = server => {},
            _ = cancel_token.cancelled() => {
                println!("WebSocket server shutting down");
            }
        }
    });

    (port, cancel_token_child)
}
