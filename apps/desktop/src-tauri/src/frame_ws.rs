use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::time::Instant;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;

static TOTAL_BYTES_SENT: AtomicU64 = AtomicU64::new(0);
static TOTAL_FRAMES_SENT: AtomicU32 = AtomicU32::new(0);
static LAST_LOG_TIME: AtomicU64 = AtomicU64::new(0);
static TOTAL_PACK_NS: AtomicU64 = AtomicU64::new(0);
static MAX_PACK_NS: AtomicU64 = AtomicU64::new(0);
static TOTAL_SEND_NS: AtomicU64 = AtomicU64::new(0);
static MAX_SEND_NS: AtomicU64 = AtomicU64::new(0);
static TOTAL_CREATED_TO_SENT_NS: AtomicU64 = AtomicU64::new(0);
static MAX_CREATED_TO_SENT_NS: AtomicU64 = AtomicU64::new(0);

const NV12_FORMAT_MAGIC: u32 = 0x4e563132;

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
    pub data: std::sync::Arc<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub frame_number: u32,
    pub target_time_ns: u64,
    pub format: WSFrameFormat,
    #[allow(dead_code)]
    pub created_at: Instant,
}

fn pack_ws_frame(frame: &WSFrame) -> Vec<u8> {
    let metadata_size = match frame.format {
        WSFrameFormat::Nv12 => 28usize,
        WSFrameFormat::Rgba => 24,
    };
    let mut buf = Vec::with_capacity(frame.data.len() + metadata_size);
    buf.extend_from_slice(&frame.data);

    match frame.format {
        WSFrameFormat::Nv12 => {
            buf.extend_from_slice(&frame.stride.to_le_bytes());
            buf.extend_from_slice(&frame.height.to_le_bytes());
            buf.extend_from_slice(&frame.width.to_le_bytes());
            buf.extend_from_slice(&frame.frame_number.to_le_bytes());
            buf.extend_from_slice(&frame.target_time_ns.to_le_bytes());
            buf.extend_from_slice(&NV12_FORMAT_MAGIC.to_le_bytes());
        }
        WSFrameFormat::Rgba => {
            buf.extend_from_slice(&frame.stride.to_le_bytes());
            buf.extend_from_slice(&frame.height.to_le_bytes());
            buf.extend_from_slice(&frame.width.to_le_bytes());
            buf.extend_from_slice(&frame.frame_number.to_le_bytes());
            buf.extend_from_slice(&frame.target_time_ns.to_le_bytes());
        }
    }

    buf
}

fn duration_ns(duration: std::time::Duration) -> u64 {
    duration.as_nanos().min(u128::from(u64::MAX)) as u64
}

fn record_ws_frame_stats(
    packed_len: usize,
    pack_duration: std::time::Duration,
    send_duration: std::time::Duration,
    created_to_sent: std::time::Duration,
) {
    TOTAL_BYTES_SENT.fetch_add(packed_len as u64, Ordering::Relaxed);
    TOTAL_FRAMES_SENT.fetch_add(1, Ordering::Relaxed);
    let pack_ns = duration_ns(pack_duration);
    let send_ns = duration_ns(send_duration);
    let created_to_sent_ns = duration_ns(created_to_sent);
    TOTAL_PACK_NS.fetch_add(pack_ns, Ordering::Relaxed);
    MAX_PACK_NS.fetch_max(pack_ns, Ordering::Relaxed);
    TOTAL_SEND_NS.fetch_add(send_ns, Ordering::Relaxed);
    MAX_SEND_NS.fetch_max(send_ns, Ordering::Relaxed);
    TOTAL_CREATED_TO_SENT_NS.fetch_add(created_to_sent_ns, Ordering::Relaxed);
    MAX_CREATED_TO_SENT_NS.fetch_max(created_to_sent_ns, Ordering::Relaxed);
}

struct SubscriberCountGuard(Arc<AtomicUsize>);

impl Drop for SubscriberCountGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub async fn create_watch_frame_ws(
    frame_rx: watch::Receiver<Option<std::sync::Arc<WSFrame>>>,
    subscribers: Arc<AtomicUsize>,
) -> (u16, CancellationToken) {
    use axum::{
        extract::{
            State,
            ws::{Message, WebSocket, WebSocketUpgrade},
        },
        response::IntoResponse,
        routing::get,
    };

    type RouterState = (
        watch::Receiver<Option<std::sync::Arc<WSFrame>>>,
        Arc<AtomicUsize>,
    );

    #[axum::debug_handler]
    async fn ws_handler(
        ws: WebSocketUpgrade,
        State((state, subscribers)): State<RouterState>,
    ) -> impl IntoResponse {
        ws.on_upgrade(move |socket| handle_socket(socket, state, subscribers))
    }

    async fn handle_socket(
        mut socket: WebSocket,
        mut camera_rx: watch::Receiver<Option<std::sync::Arc<WSFrame>>>,
        subscribers: Arc<AtomicUsize>,
    ) {
        tracing::info!("Socket connection established");
        let now = std::time::Instant::now();

        subscribers.fetch_add(1, Ordering::AcqRel);
        let _subscriber_guard = SubscriberCountGuard(subscribers);

        {
            let packed = {
                let borrowed = camera_rx.borrow();
                borrowed.as_deref().map(pack_ws_frame)
            };
            if let Some(packed) = packed
                && let Err(e) = socket.send(Message::Binary(packed)).await
            {
                tracing::error!("Failed to send initial frame to socket: {:?}", e);
                return;
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
                    let frame_arc = camera_rx.borrow_and_update().clone();
                    if let Some(ref frame) = frame_arc {
                        let width = frame.width;
                        let height = frame.height;
                        let format_label = match frame.format {
                            WSFrameFormat::Nv12 => "NV12",
                            WSFrameFormat::Rgba => "RGBA",
                        };

                        let pack_start = Instant::now();
                        let packed = pack_ws_frame(frame);
                        let pack_duration = pack_start.elapsed();
                        let packed_len = packed.len();

                        let send_start = Instant::now();
                        match socket.send(Message::Binary(packed)).await {
                            Ok(()) => {
                                let send_duration = send_start.elapsed();
                                record_ws_frame_stats(
                                    packed_len,
                                    pack_duration,
                                    send_duration,
                                    frame.created_at.elapsed(),
                                );
                                let now_ms = SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .map(|duration| duration.as_millis() as u64)
                                    .unwrap_or_default();
                                let last_log = LAST_LOG_TIME.load(Ordering::Relaxed);
                                if now_ms - last_log > 2000 {
                                    LAST_LOG_TIME.store(now_ms, Ordering::Relaxed);
                                    let total_bytes = TOTAL_BYTES_SENT.swap(0, Ordering::Relaxed);
                                    let total_frames = TOTAL_FRAMES_SENT.swap(0, Ordering::Relaxed);
                                    let total_pack_ns = TOTAL_PACK_NS.swap(0, Ordering::Relaxed);
                                    let max_pack_ns = MAX_PACK_NS.swap(0, Ordering::Relaxed);
                                    let total_send_ns = TOTAL_SEND_NS.swap(0, Ordering::Relaxed);
                                    let max_send_ns = MAX_SEND_NS.swap(0, Ordering::Relaxed);
                                    let total_created_to_sent_ns =
                                        TOTAL_CREATED_TO_SENT_NS.swap(0, Ordering::Relaxed);
                                    let max_created_to_sent_ns =
                                        MAX_CREATED_TO_SENT_NS.swap(0, Ordering::Relaxed);
                                    let frames = total_frames.max(1) as f64;
                                    let mb_per_sec = total_bytes as f64 / 1_000_000.0 / 2.0;
                                    tracing::info!(
                                        fps = total_frames / 2,
                                        mb_per_sec = format!("{:.1}", mb_per_sec),
                                        avg_kb = format!("{:.1}", (total_bytes as f64 / total_frames.max(1) as f64) / 1024.0),
                                        pack_avg_ms = format!("{:.3}", total_pack_ns as f64 / frames / 1_000_000.0),
                                        pack_max_ms = format!("{:.3}", max_pack_ns as f64 / 1_000_000.0),
                                        send_avg_ms = format!("{:.3}", total_send_ns as f64 / frames / 1_000_000.0),
                                        send_max_ms = format!("{:.3}", max_send_ns as f64 / 1_000_000.0),
                                        created_to_sent_avg_ms = format!("{:.3}", total_created_to_sent_ns as f64 / frames / 1_000_000.0),
                                        created_to_sent_max_ms = format!("{:.3}", max_created_to_sent_ns as f64 / 1_000_000.0),
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
        .with_state((frame_rx, subscribers));

    let cancel_token = CancellationToken::new();
    let cancel_token_child = cancel_token.child_token();
    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(listener) => listener,
        Err(err) => {
            tracing::error!("Failed to bind watch frame websocket listener: {err}");
            return (0, cancel_token_child);
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(err) => {
            tracing::error!("Failed to read watch frame websocket listener address: {err}");
            return (0, cancel_token_child);
        }
    };
    tracing::info!("WebSocket server listening on port {}", port);

    tokio::spawn(async move {
        let server = axum::serve(listener, router.into_make_service());
        tokio::select! {
            _ = server => {},
            _ = cancel_token.cancelled() => {
                tracing::info!("WebSocket server shutting down");
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
                                std::sync::Arc::unwrap_or_clone(frame.data),
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
        tracing::info!("Websocket closing after {elapsed:.2?}");
    }

    let router = axum::Router::new()
        .route("/", get(ws_handler))
        .with_state(frame_tx);

    let cancel_token = CancellationToken::new();
    let cancel_token_child = cancel_token.child_token();
    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(listener) => listener,
        Err(err) => {
            tracing::error!("Failed to bind frame websocket listener: {err}");
            return (0, cancel_token_child);
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(err) => {
            tracing::error!("Failed to read frame websocket listener address: {err}");
            return (0, cancel_token_child);
        }
    };
    tracing::info!("WebSocket server listening on port {}", port);

    tokio::spawn(async move {
        let server = axum::serve(listener, router.into_make_service());
        tokio::select! {
            _ = server => {},
            _ = cancel_token.cancelled() => {
                tracing::info!("WebSocket server shutting down");
            }
        }
    });

    (port, cancel_token_child)
}
