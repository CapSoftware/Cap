use serde::Deserialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;

const NV12_VIDEO_FORMAT_MAGIC: u32 = 0x4e563132;
const NV12_FULL_FORMAT_MAGIC: u32 = 0x4e563146;

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
    Nv12 { full_range: bool },
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
        WSFrameFormat::Nv12 { .. } => 28usize,
        WSFrameFormat::Rgba => 24,
    };
    let mut buf = Vec::with_capacity(frame.data.len() + metadata_size);
    buf.extend_from_slice(&frame.data);

    match frame.format {
        WSFrameFormat::Nv12 { full_range } => {
            buf.extend_from_slice(&frame.stride.to_le_bytes());
            buf.extend_from_slice(&frame.height.to_le_bytes());
            buf.extend_from_slice(&frame.width.to_le_bytes());
            buf.extend_from_slice(&frame.frame_number.to_le_bytes());
            buf.extend_from_slice(&frame.target_time_ns.to_le_bytes());
            let magic = if full_range {
                NV12_FULL_FORMAT_MAGIC
            } else {
                NV12_VIDEO_FORMAT_MAGIC
            };
            buf.extend_from_slice(&magic.to_le_bytes());
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

#[derive(Default)]
struct WsFrameStats {
    total_bytes_sent: u64,
    total_frames_sent: u32,
    last_log_time_ms: u64,
    total_pack_ns: u64,
    max_pack_ns: u64,
    total_send_ns: u64,
    max_send_ns: u64,
    total_created_to_sent_ns: u64,
    max_created_to_sent_ns: u64,
}

impl WsFrameStats {
    fn record(
        &mut self,
        packed_len: usize,
        pack_duration: std::time::Duration,
        send_duration: std::time::Duration,
        created_to_sent: std::time::Duration,
    ) {
        self.total_bytes_sent += packed_len as u64;
        self.total_frames_sent += 1;
        let pack_ns = duration_ns(pack_duration);
        let send_ns = duration_ns(send_duration);
        let created_to_sent_ns = duration_ns(created_to_sent);
        self.total_pack_ns += pack_ns;
        self.max_pack_ns = self.max_pack_ns.max(pack_ns);
        self.total_send_ns += send_ns;
        self.max_send_ns = self.max_send_ns.max(send_ns);
        self.total_created_to_sent_ns += created_to_sent_ns;
        self.max_created_to_sent_ns = self.max_created_to_sent_ns.max(created_to_sent_ns);
    }

    fn reset_window(&mut self, now_ms: u64) -> WsFrameStatsWindow {
        self.last_log_time_ms = now_ms;
        WsFrameStatsWindow {
            total_bytes_sent: std::mem::take(&mut self.total_bytes_sent),
            total_frames_sent: std::mem::take(&mut self.total_frames_sent),
            total_pack_ns: std::mem::take(&mut self.total_pack_ns),
            max_pack_ns: std::mem::take(&mut self.max_pack_ns),
            total_send_ns: std::mem::take(&mut self.total_send_ns),
            max_send_ns: std::mem::take(&mut self.max_send_ns),
            total_created_to_sent_ns: std::mem::take(&mut self.total_created_to_sent_ns),
            max_created_to_sent_ns: std::mem::take(&mut self.max_created_to_sent_ns),
        }
    }
}

struct WsFrameStatsWindow {
    total_bytes_sent: u64,
    total_frames_sent: u32,
    total_pack_ns: u64,
    max_pack_ns: u64,
    total_send_ns: u64,
    max_send_ns: u64,
    total_created_to_sent_ns: u64,
    max_created_to_sent_ns: u64,
}

struct SubscriberCountGuard {
    subscribers: Arc<AtomicUsize>,
    instant_subscribers: Option<Arc<AtomicUsize>>,
}

impl Drop for SubscriberCountGuard {
    fn drop(&mut self) {
        self.subscribers.fetch_sub(1, Ordering::AcqRel);
        if let Some(instant_subscribers) = &self.instant_subscribers {
            instant_subscribers.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

#[derive(Deserialize)]
struct WatchFrameQuery {
    #[serde(default)]
    instant: bool,
}

fn is_normal_socket_disconnect(error: &impl std::fmt::Debug) -> bool {
    let error = format!("{error:?}");
    error.contains("BrokenPipe")
        || error.contains("Broken pipe")
        || error.contains("ConnectionReset")
        || error.contains("Connection reset by peer")
}

pub async fn create_watch_frame_ws(
    frame_rx: watch::Receiver<Option<std::sync::Arc<WSFrame>>>,
    subscribers: Arc<AtomicUsize>,
) -> (u16, CancellationToken) {
    create_watch_frame_ws_inner(frame_rx, subscribers, None).await
}

pub async fn create_watch_frame_ws_with_instant_tracking(
    frame_rx: watch::Receiver<Option<std::sync::Arc<WSFrame>>>,
    subscribers: Arc<AtomicUsize>,
    instant_subscribers: Arc<AtomicUsize>,
) -> (u16, CancellationToken) {
    create_watch_frame_ws_inner(frame_rx, subscribers, Some(instant_subscribers)).await
}

async fn create_watch_frame_ws_inner(
    frame_rx: watch::Receiver<Option<std::sync::Arc<WSFrame>>>,
    subscribers: Arc<AtomicUsize>,
    instant_subscribers: Option<Arc<AtomicUsize>>,
) -> (u16, CancellationToken) {
    use axum::{
        extract::{
            Query, State,
            ws::{Message, WebSocket, WebSocketUpgrade},
        },
        response::IntoResponse,
        routing::get,
    };

    type RouterState = (
        watch::Receiver<Option<std::sync::Arc<WSFrame>>>,
        Arc<AtomicUsize>,
        Option<Arc<AtomicUsize>>,
    );

    #[axum::debug_handler]
    async fn ws_handler(
        ws: WebSocketUpgrade,
        Query(query): Query<WatchFrameQuery>,
        State((state, subscribers, instant_subscribers)): State<RouterState>,
    ) -> impl IntoResponse {
        let instant_subscribers = query.instant.then_some(instant_subscribers).flatten();
        ws.on_upgrade(move |socket| handle_socket(socket, state, subscribers, instant_subscribers))
    }

    async fn handle_socket(
        mut socket: WebSocket,
        mut camera_rx: watch::Receiver<Option<std::sync::Arc<WSFrame>>>,
        subscribers: Arc<AtomicUsize>,
        instant_subscribers: Option<Arc<AtomicUsize>>,
    ) {
        tracing::info!("Socket connection established");
        let now = std::time::Instant::now();
        let mut stats = WsFrameStats::default();

        subscribers.fetch_add(1, Ordering::AcqRel);
        if let Some(instant_subscribers) = &instant_subscribers {
            instant_subscribers.fetch_add(1, Ordering::AcqRel);
        }
        let _subscriber_guard = SubscriberCountGuard {
            subscribers,
            instant_subscribers,
        };

        {
            let packed = {
                let borrowed = camera_rx.borrow();
                borrowed
                    .as_deref()
                    .map(|frame| (pack_ws_frame(frame), frame.created_at.elapsed()))
            };
            match packed {
                Some((packed, frame_age)) => {
                    if let Err(e) = socket.send(Message::Binary(packed)).await {
                        if is_normal_socket_disconnect(&e) {
                            tracing::debug!(
                                "Initial frame send skipped because socket closed: {:?}",
                                e
                            );
                        } else {
                            tracing::error!("Failed to send initial frame to socket: {:?}", e);
                        }
                        return;
                    }
                    tracing::info!(
                        frame_age_ms = frame_age.as_millis() as u64,
                        "Editor open: initial frame delivered to new socket"
                    );
                }
                None => {
                    tracing::info!("Editor open: socket connected before any frame was rendered");
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
                            if is_normal_socket_disconnect(&e) {
                                tracing::debug!("WebSocket closed by client: {:?}", e);
                            } else {
                                tracing::error!("WebSocket error: {:?}", e);
                            }
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
                            WSFrameFormat::Nv12 { full_range: false } => "NV12",
                            WSFrameFormat::Nv12 { full_range: true } => "NV12-full",
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
                                stats.record(
                                    packed_len,
                                    pack_duration,
                                    send_duration,
                                    frame.created_at.elapsed(),
                                );
                                let now_ms = SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .map(|duration| duration.as_millis() as u64)
                                    .unwrap_or_default();
                                if now_ms.saturating_sub(stats.last_log_time_ms) > 2000 {
                                    let window = stats.reset_window(now_ms);
                                    let frames = window.total_frames_sent.max(1) as f64;
                                    let mb_per_sec = window.total_bytes_sent as f64 / 1_000_000.0 / 2.0;
                                    tracing::info!(
                                        fps = window.total_frames_sent / 2,
                                        mb_per_sec = format!("{:.1}", mb_per_sec),
                                        avg_kb = format!("{:.1}", (window.total_bytes_sent as f64 / window.total_frames_sent.max(1) as f64) / 1024.0),
                                        pack_avg_ms = format!("{:.3}", window.total_pack_ns as f64 / frames / 1_000_000.0),
                                        pack_max_ms = format!("{:.3}", window.max_pack_ns as f64 / 1_000_000.0),
                                        send_avg_ms = format!("{:.3}", window.total_send_ns as f64 / frames / 1_000_000.0),
                                        send_max_ms = format!("{:.3}", window.max_send_ns as f64 / 1_000_000.0),
                                        created_to_sent_avg_ms = format!("{:.3}", window.total_created_to_sent_ns as f64 / frames / 1_000_000.0),
                                        created_to_sent_max_ms = format!("{:.3}", window.max_created_to_sent_ns as f64 / 1_000_000.0),
                                        dims = format!("{}x{}", width, height),
                                        format = format_label,
                                        "WS frame stats"
                                    );
                                }
                            }
                            Err(e) => {
                                if is_normal_socket_disconnect(&e) {
                                    tracing::debug!("Frame send stopped because socket closed: {:?}", e);
                                } else {
                                    tracing::error!("Failed to send frame to socket: {:?}", e);
                                }
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

    let router = axum::Router::new().route("/", get(ws_handler)).with_state((
        frame_rx,
        subscribers,
        instant_subscribers,
    ));

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
                            if is_normal_socket_disconnect(&e) {
                                tracing::debug!("WebSocket closed by client: {:?}", e);
                            } else {
                                tracing::error!("WebSocket error: {:?}", e);
                            }
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
                                if is_normal_socket_disconnect(&e) {
                                    tracing::debug!("Frame send stopped because socket closed: {:?}", e);
                                } else {
                                    tracing::error!("Failed to send frame to socket: {:?}", e);
                                }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(format: WSFrameFormat) -> WSFrame {
        WSFrame {
            data: Arc::new(vec![1, 2, 3, 4, 5, 6]),
            width: 2,
            height: 2,
            stride: 2,
            frame_number: 7,
            target_time_ns: 8,
            format,
            created_at: Instant::now(),
        }
    }

    #[test]
    fn packs_rgba_frame_with_legacy_metadata_shape() {
        let packed = pack_ws_frame(&frame(WSFrameFormat::Rgba));

        assert_eq!(packed.len(), 30);
        assert_eq!(&packed[..6], &[1, 2, 3, 4, 5, 6]);
        assert_eq!(u32::from_le_bytes(packed[6..10].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(packed[18..22].try_into().unwrap()), 7);
        assert_eq!(u64::from_le_bytes(packed[22..30].try_into().unwrap()), 8);
    }

    #[test]
    fn packs_nv12_frame_with_video_range_marker() {
        let packed = pack_ws_frame(&frame(WSFrameFormat::Nv12 { full_range: false }));

        assert_eq!(packed.len(), 34);
        assert_eq!(
            u32::from_le_bytes(packed[30..34].try_into().unwrap()),
            NV12_VIDEO_FORMAT_MAGIC
        );
    }

    #[test]
    fn subscriber_guard_decrements_both_counts() {
        let subscribers = Arc::new(AtomicUsize::new(1));
        let instant_subscribers = Arc::new(AtomicUsize::new(1));

        drop(SubscriberCountGuard {
            subscribers: subscribers.clone(),
            instant_subscribers: Some(instant_subscribers.clone()),
        });

        assert_eq!(subscribers.load(Ordering::Acquire), 0);
        assert_eq!(instant_subscribers.load(Ordering::Acquire), 0);
    }
}
