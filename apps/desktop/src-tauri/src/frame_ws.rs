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
        CancellationToken,
    );

    #[axum::debug_handler]
    async fn ws_handler(
        ws: WebSocketUpgrade,
        Query(query): Query<WatchFrameQuery>,
        State((state, subscribers, instant_subscribers, shutdown)): State<RouterState>,
    ) -> impl IntoResponse {
        let instant_subscribers = query.instant.then_some(instant_subscribers).flatten();
        ws.on_upgrade(move |socket| async move {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => {},
                _ = handle_socket(socket, state, subscribers, instant_subscribers) => {},
            }
        })
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
                changed = camera_rx.changed() => {
                    if changed.is_err() {
                        break;
                    }
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

    let cancel_token = CancellationToken::new();
    let server_shutdown = cancel_token.child_token();
    let router = axum::Router::new().route("/", get(ws_handler)).with_state((
        frame_rx,
        subscribers,
        instant_subscribers,
        server_shutdown.clone(),
    ));
    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(listener) => listener,
        Err(err) => {
            tracing::error!("Failed to bind watch frame websocket listener: {err}");
            cancel_token.cancel();
            return (0, cancel_token);
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(err) => {
            tracing::error!("Failed to read watch frame websocket listener address: {err}");
            cancel_token.cancel();
            return (0, cancel_token);
        }
    };
    tracing::info!("WebSocket server listening on port {}", port);

    tokio::spawn(async move {
        let _shutdown_guard = server_shutdown.clone().drop_guard();
        let server = axum::serve(listener, router.into_make_service())
            .with_graceful_shutdown(server_shutdown.clone().cancelled_owned());
        tokio::select! {
            biased;
            _ = server_shutdown.cancelled() => {
                tracing::info!("WebSocket server shutting down");
            },
            _ = server => {},
        }
    });

    (port, cancel_token)
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

    type RouterState = (broadcast::Sender<WSFrame>, CancellationToken);

    #[axum::debug_handler]
    async fn ws_handler(
        ws: WebSocketUpgrade,
        State((state, shutdown)): State<RouterState>,
    ) -> impl IntoResponse {
        let rx = state.subscribe();
        ws.on_upgrade(move |socket| async move {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => {},
                _ = handle_socket(socket, rx) => {},
            }
        })
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

    let cancel_token = CancellationToken::new();
    let server_shutdown = cancel_token.child_token();
    let router = axum::Router::new()
        .route("/", get(ws_handler))
        .with_state((frame_tx, server_shutdown.clone()));
    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(listener) => listener,
        Err(err) => {
            tracing::error!("Failed to bind frame websocket listener: {err}");
            cancel_token.cancel();
            return (0, cancel_token);
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(err) => {
            tracing::error!("Failed to read frame websocket listener address: {err}");
            cancel_token.cancel();
            return (0, cancel_token);
        }
    };
    tracing::info!("WebSocket server listening on port {}", port);

    tokio::spawn(async move {
        let _shutdown_guard = server_shutdown.clone().drop_guard();
        let server = axum::serve(listener, router.into_make_service())
            .with_graceful_shutdown(server_shutdown.clone().cancelled_owned());
        tokio::select! {
            biased;
            _ = server_shutdown.cancelled() => {
                tracing::info!("WebSocket server shutting down");
            },
            _ = server => {},
        }
    });

    (port, cancel_token)
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

#[cfg(test)]
mod shutdown_tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    fn frame() -> WSFrame {
        WSFrame {
            data: Arc::new(vec![1, 2, 3, 4]),
            width: 1,
            height: 1,
            stride: 4,
            frame_number: 42,
            target_time_ns: 1234,
            format: WSFrameFormat::Rgba,
            created_at: Instant::now(),
        }
    }

    async fn wait_until(condition: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !condition() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("shutdown condition did not settle");
    }

    async fn connect(port: u16, instant: bool) -> TcpStream {
        assert_ne!(port, 0);
        tokio::time::timeout(Duration::from_secs(2), async {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let path = if instant { "/?instant=true" } else { "/" };
            let request = format!(
                "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
            );
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut response = Vec::new();
            while !response.ends_with(b"\r\n\r\n") {
                assert!(response.len() < 4096);
                response.push(stream.read_u8().await.unwrap());
            }
            assert!(response.starts_with(b"HTTP/1.1 101"));
            stream
        })
        .await
        .expect("websocket handshake timed out")
    }

    async fn read_binary(stream: &mut TcpStream) -> Vec<u8> {
        tokio::time::timeout(Duration::from_secs(2), async {
            assert_eq!(stream.read_u8().await.unwrap(), 0x82);
            let length = stream.read_u8().await.unwrap();
            assert!(length < 126);
            let mut data = vec![0; usize::from(length)];
            stream.read_exact(&mut data).await.unwrap();
            data
        })
        .await
        .expect("frame delivery timed out")
    }

    async fn assert_disconnected(stream: &mut TcpStream) {
        tokio::time::timeout(Duration::from_secs(2), async {
            let mut buffer = [0; 8192];
            loop {
                match stream.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        })
        .await
        .expect("connected websocket did not close");
    }

    async fn assert_listener_closed(port: u16) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("websocket listener still accepts connections");
    }

    async fn assert_unused_port_released(port: u16) {
        let listener = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)).await {
                    break listener;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("websocket listener still owns its port");
        drop(listener);
        assert_listener_closed(port).await;
    }

    #[tokio::test]
    async fn watch_listener_releases_port_after_cancel_before_server_poll() {
        let (_tx, rx) = watch::channel(None);
        let (port, shutdown) = create_watch_frame_ws(rx, Default::default()).await;
        shutdown.cancel();
        assert_unused_port_released(port).await;
    }

    #[tokio::test]
    async fn broadcast_listener_releases_port_after_cancel_before_server_poll() {
        let (tx, _rx) = broadcast::channel(2);
        let (port, shutdown) = create_frame_ws(tx).await;
        shutdown.cancel();
        assert_unused_port_released(port).await;
    }

    #[tokio::test]
    async fn watch_shutdown_drains_existing_clients_and_subscriber_counts() {
        let (tx, rx) = watch::channel(None);
        let subscribers = Arc::new(AtomicUsize::new(0));
        let instant = Arc::new(AtomicUsize::new(0));
        let (port, shutdown) =
            create_watch_frame_ws_with_instant_tracking(rx, subscribers.clone(), instant.clone())
                .await;
        let mut first = connect(port, false).await;
        let mut second = connect(port, true).await;
        wait_until(|| subscribers.load(Ordering::Acquire) == 2).await;
        assert_eq!(instant.load(Ordering::Acquire), 1);
        let frame = frame();
        let expected = pack_ws_frame(&frame);
        tx.send(Some(Arc::new(frame))).unwrap();
        assert_eq!(read_binary(&mut first).await, expected);
        assert_eq!(read_binary(&mut second).await, expected);
        shutdown.cancel();
        assert_disconnected(&mut first).await;
        assert_disconnected(&mut second).await;
        wait_until(|| subscribers.load(Ordering::Acquire) == 0 && tx.receiver_count() == 0).await;
        assert_eq!(instant.load(Ordering::Acquire), 0);
        assert_listener_closed(port).await;
    }

    #[tokio::test]
    async fn broadcast_shutdown_drains_existing_clients() {
        let (tx, rx) = broadcast::channel(2);
        drop(rx);
        let (port, shutdown) = create_frame_ws(tx.clone()).await;
        let mut first = connect(port, false).await;
        let mut second = connect(port, false).await;
        let frame = frame();
        let expected = pack_ws_frame(&frame);
        assert!(matches!(tx.send(frame), Ok(2)));
        assert_eq!(read_binary(&mut first).await, expected);
        assert_eq!(read_binary(&mut second).await, expected);
        shutdown.cancel();
        assert_disconnected(&mut first).await;
        assert_disconnected(&mut second).await;
        wait_until(|| tx.receiver_count() == 0).await;
        assert_listener_closed(port).await;
    }

    #[tokio::test]
    async fn watch_source_close_does_not_resend_retained_frame() {
        let frame = Arc::new(frame());
        let (tx, rx) = watch::channel(Some(frame.clone()));
        let subscribers = Arc::new(AtomicUsize::new(0));
        let (port, shutdown) = create_watch_frame_ws(rx, subscribers.clone()).await;
        let mut client = connect(port, false).await;
        assert_eq!(read_binary(&mut client).await, pack_ws_frame(&frame));
        drop(tx);
        wait_until(|| subscribers.load(Ordering::Acquire) == 0).await;
        assert_disconnected(&mut client).await;
        shutdown.cancel();
        assert_listener_closed(port).await;
    }

    #[tokio::test]
    async fn watch_shutdown_interrupts_stalled_initial_send() {
        let mut frame = frame();
        frame.width = 4096;
        frame.height = 1024;
        frame.stride = 4096 * 4;
        frame.data = Arc::new(vec![0; frame.stride as usize * frame.height as usize]);
        let weak_data = Arc::downgrade(&frame.data);
        let (tx, rx) = watch::channel(Some(Arc::new(frame)));
        let subscribers = Arc::new(AtomicUsize::new(0));
        let (port, shutdown) = create_watch_frame_ws(rx, subscribers.clone()).await;
        let client = connect(port, false).await;
        wait_until(|| subscribers.load(Ordering::Acquire) == 1).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        shutdown.cancel();
        wait_until(|| subscribers.load(Ordering::Acquire) == 0 && tx.receiver_count() == 0).await;
        drop(tx);
        assert!(weak_data.upgrade().is_none());
        drop(client);
        assert_listener_closed(port).await;
    }

    #[tokio::test]
    async fn cancelling_owner_child_does_not_stop_sibling_server() {
        let (tx, rx) = watch::channel(None);
        let (port, shutdown) = create_watch_frame_ws(rx, Default::default()).await;
        shutdown.child_token().cancel();
        assert!(!shutdown.is_cancelled());
        let mut client = connect(port, false).await;
        let frame = frame();
        let expected = pack_ws_frame(&frame);
        tx.send(Some(Arc::new(frame))).unwrap();
        assert_eq!(read_binary(&mut client).await, expected);
        shutdown.cancel();
        assert_disconnected(&mut client).await;
        assert_listener_closed(port).await;
    }

    #[tokio::test]
    async fn dropping_owner_token_preserves_app_scoped_camera_server() {
        let (tx, rx) = watch::channel(None);
        let (port, shutdown) = create_watch_frame_ws(rx, Default::default()).await;
        drop(shutdown);
        let mut client = connect(port, false).await;
        let frame = frame();
        let expected = pack_ws_frame(&frame);
        tx.send(Some(Arc::new(frame))).unwrap();
        assert_eq!(read_binary(&mut client).await, expected);
    }

    #[tokio::test]
    async fn aborted_construction_drop_guard_releases_listener() {
        let (port_tx, port_rx) = tokio::sync::oneshot::channel();
        let construction = tokio::spawn(async move {
            let (_tx, rx) = watch::channel(None);
            let (port, shutdown) = create_watch_frame_ws(rx, Default::default()).await;
            let _guard = shutdown.clone().drop_guard();
            port_tx.send(port).unwrap();
            std::future::pending::<()>().await;
        });
        let port = port_rx.await.unwrap();
        construction.abort();
        assert!(construction.await.unwrap_err().is_cancelled());
        assert_unused_port_released(port).await;
    }

    #[tokio::test]
    async fn successful_construction_disarms_guard_until_owner_cancels() {
        let (tx, rx) = watch::channel(None);
        let (port, shutdown) = create_watch_frame_ws(rx, Default::default()).await;
        let guard = shutdown.clone().drop_guard();
        drop(guard.disarm());
        let mut client = connect(port, false).await;
        let frame = frame();
        let expected = pack_ws_frame(&frame);
        tx.send(Some(Arc::new(frame))).unwrap();
        assert_eq!(read_binary(&mut client).await, expected);
        shutdown.cancel();
        assert_disconnected(&mut client).await;
        assert_listener_closed(port).await;
    }

    #[tokio::test]
    async fn repeated_watch_open_cancel_releases_every_port() {
        for _ in 0..20 {
            let (_tx, rx) = watch::channel(None);
            let (port, shutdown) = create_watch_frame_ws(rx, Default::default()).await;
            let mut client = connect(port, false).await;
            shutdown.cancel();
            assert_disconnected(&mut client).await;
            assert_listener_closed(port).await;
        }
    }

    async fn connect_http_client(port: u16) -> TcpStream {
        tokio::time::timeout(Duration::from_secs(2), async {
            let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            client
                .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .await
                .unwrap();
            let mut response = Vec::new();
            while !response.ends_with(b"\r\n\r\n") {
                assert!(response.len() < 4096);
                response.push(client.read_u8().await.unwrap());
            }
            assert!(response.starts_with(b"HTTP/1.1 400"));
            let headers = std::str::from_utf8(&response).unwrap();
            let length = headers
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .unwrap()
                .1
                .trim()
                .parse::<usize>()
                .unwrap();
            assert!(length < 4096);
            client.read_exact(&mut vec![0; length]).await.unwrap();
            client
        })
        .await
        .expect("HTTP connection did not become ready")
    }

    #[tokio::test]
    async fn watch_shutdown_drains_incomplete_http_upgrade() {
        let (tx, rx) = watch::channel(None);
        let (port, shutdown) = create_watch_frame_ws(rx, Default::default()).await;
        let mut client = connect_http_client(port).await;
        client
            .write_all(b"GET / HTTP/1.1\r\nUpgrade: websocket\r\n")
            .await
            .unwrap();
        tokio::task::yield_now().await;
        shutdown.cancel();
        assert_disconnected(&mut client).await;
        wait_until(|| tx.receiver_count() == 0).await;
        assert_listener_closed(port).await;
    }

    #[tokio::test]
    async fn broadcast_shutdown_drains_incomplete_http_upgrade() {
        let (tx, rx) = broadcast::channel(2);
        drop(rx);
        let (port, shutdown) = create_frame_ws(tx.clone()).await;
        let mut client = connect_http_client(port).await;
        client
            .write_all(b"GET / HTTP/1.1\r\nUpgrade: websocket\r\n")
            .await
            .unwrap();
        tokio::task::yield_now().await;
        shutdown.cancel();
        assert_disconnected(&mut client).await;
        wait_until(|| tx.strong_count() == 1).await;
        assert_listener_closed(port).await;
    }

    #[tokio::test]
    async fn watch_shutdown_drains_http_keep_alive_connection() {
        let (tx, rx) = watch::channel(None);
        let (port, shutdown) = create_watch_frame_ws(rx, Default::default()).await;
        let mut client = connect_http_client(port).await;
        shutdown.cancel();
        assert_disconnected(&mut client).await;
        wait_until(|| tx.receiver_count() == 0).await;
        assert_listener_closed(port).await;
    }
}
