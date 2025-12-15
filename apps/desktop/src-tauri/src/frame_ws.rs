use std::time::Instant;
use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;

fn compress_frame_data(mut data: Vec<u8>, stride: u32, height: u32, width: u32) -> Vec<u8> {
    data.extend_from_slice(&stride.to_le_bytes());
    data.extend_from_slice(&height.to_le_bytes());
    data.extend_from_slice(&width.to_le_bytes());

    lz4_flex::compress_prepend_size(&data)
}

#[derive(Clone)]
pub struct WSFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub created_at: Instant,
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

    async fn handle_socket(mut socket: WebSocket, mut camera_rx: RouterState) {
        println!("socket connection established");
        tracing::info!("Socket connection established");
        let now = std::time::Instant::now();

        let mut frames_sent = 0u64;
        let mut total_latency_us = 0u64;
        let mut max_latency_us = 0u64;

        {
            let frame_opt = camera_rx.borrow().clone();
            if let Some(frame) = frame_opt {
                let frame_latency = frame.created_at.elapsed();
                let latency_us = frame_latency.as_micros() as u64;
                total_latency_us += latency_us;
                max_latency_us = max_latency_us.max(latency_us);
                frames_sent += 1;

                let original_size = frame.data.len();
                let packed =
                    compress_frame_data(frame.data, frame.stride, frame.height, frame.width);
                let compressed_size = packed.len();

                if let Err(e) = socket.send(Message::Binary(packed)).await {
                    tracing::error!("Failed to send initial frame to socket: {:?}", e);
                    return;
                }

                tracing::debug!(
                    frame_latency_us = latency_us,
                    original_size_bytes = original_size,
                    compressed_size_bytes = compressed_size,
                    compression_ratio = %format!("{:.1}%", (compressed_size as f64 / original_size as f64) * 100.0),
                    "[PERF:WS_WATCH] initial frame sent (compressed)"
                );
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
                        Some(Ok(_)) => {
                            tracing::info!("Received message from socket (ignoring)");
                        }
                        Some(Err(e)) => {
                            tracing::error!("WebSocket error: {:?}", e);
                            break;
                        }
                    }
                },
                res = camera_rx.changed() => {
                    if res.is_err() {
                         tracing::error!("Camera channel closed");
                         break;
                    }
                    let frame_opt = camera_rx.borrow().clone();
                    if let Some(frame) = frame_opt {
                        let frame_latency = frame.created_at.elapsed();
                        let latency_us = frame_latency.as_micros() as u64;
                        total_latency_us += latency_us;
                        max_latency_us = max_latency_us.max(latency_us);
                        frames_sent += 1;

                        let send_start = Instant::now();
                        let original_size = frame.data.len();
                        let packed = compress_frame_data(frame.data, frame.stride, frame.height, frame.width);
                        let compressed_size = packed.len();

                        if let Err(e) = socket.send(Message::Binary(packed)).await {
                            tracing::error!("Failed to send frame to socket: {:?}", e);
                            break;
                        }
                        let send_time = send_start.elapsed();

                        tracing::debug!(
                            frame_latency_us = latency_us,
                            send_time_us = send_time.as_micros() as u64,
                            original_size_bytes = original_size,
                            compressed_size_bytes = compressed_size,
                            "[PERF:WS_WATCH] frame sent (compressed)"
                        );

                        // #region agent log
                        use std::io::Write;
                        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open("/Users/macbookuser/Documents/GitHub/cap/.cursor/debug.log") {
                            let log_entry = serde_json::json!({
                                "location": "frame_ws.rs:ws_send",
                                "message": "websocket frame sent",
                                "data": {
                                    "frame_latency_us": latency_us,
                                    "send_time_us": send_time.as_micros() as u64,
                                    "original_size_bytes": original_size,
                                    "compressed_size_bytes": compressed_size,
                                    "compression_ratio_pct": format!("{:.1}", (compressed_size as f64 / original_size as f64) * 100.0)
                                },
                                "timestamp": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,
                                "sessionId": "debug-session",
                                "hypothesisId": "A"
                            });
                            writeln!(file, "{}", log_entry).ok();
                        }
                        // #endregion
                    }
                }
            }
        }

        if frames_sent > 0 {
            let avg_latency = total_latency_us / frames_sent;
            tracing::info!(
                total_frames_sent = frames_sent,
                avg_latency_us = avg_latency,
                max_latency_us = max_latency_us,
                "[PERF:WS_WATCH] session ended - final metrics"
            );
        }

        let elapsed = now.elapsed();
        println!("Websocket closing after {elapsed:.2?}");
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

        let mut frames_sent = 0u64;
        let mut frames_lagged = 0u64;
        let mut total_latency_us = 0u64;
        let mut max_latency_us = 0u64;
        let mut last_metrics_log = Instant::now();

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
                            let frame_latency = frame.created_at.elapsed();
                            let latency_us = frame_latency.as_micros() as u64;
                            total_latency_us += latency_us;
                            max_latency_us = max_latency_us.max(latency_us);
                            frames_sent += 1;

                            let send_start = Instant::now();
                            let original_size = frame.data.len();
                            let packed = compress_frame_data(frame.data, frame.stride, frame.height, frame.width);
                            let compressed_size = packed.len();

                            if let Err(e) = socket.send(Message::Binary(packed)).await {
                                tracing::error!("Failed to send frame to socket: {:?}", e);
                                break;
                            }
                            let send_time = send_start.elapsed();

                            tracing::debug!(
                                frame_latency_us = latency_us,
                                send_time_us = send_time.as_micros() as u64,
                                original_size_bytes = original_size,
                                compressed_size_bytes = compressed_size,
                                width = frame.width,
                                height = frame.height,
                                "[PERF:WS] frame sent (compressed)"
                            );

                            if frame_latency.as_millis() > 50 {
                                tracing::warn!(
                                    frame_latency_ms = frame_latency.as_millis() as u64,
                                    "[PERF:WS] high frame latency detected"
                                );
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            tracing::error!(
                                "Connection has been lost! Shutting down websocket server"
                            );
                            break;
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            frames_lagged += skipped;
                            tracing::warn!(
                                skipped = skipped,
                                total_lagged = frames_lagged,
                                "[PERF:WS] frames lagged/dropped"
                            );
                            // #region agent log
                            use std::io::Write;
                            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open("/Users/macbookuser/Documents/GitHub/cap/.cursor/debug.log") {
                                let log_entry = serde_json::json!({
                                    "location": "frame_ws.rs:frames_lagged",
                                    "message": "broadcast frames dropped",
                                    "data": {
                                        "skipped": skipped,
                                        "total_lagged": frames_lagged
                                    },
                                    "timestamp": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,
                                    "sessionId": "debug-session",
                                    "hypothesisId": "P"
                                });
                                writeln!(file, "{}", log_entry).ok();
                            }
                            // #endregion
                            continue;
                        }
                    }
                }
            }

            if last_metrics_log.elapsed().as_secs() >= 2 && frames_sent > 0 {
                let avg_latency = total_latency_us / frames_sent;
                tracing::info!(
                    frames_sent = frames_sent,
                    frames_lagged = frames_lagged,
                    avg_latency_us = avg_latency,
                    max_latency_us = max_latency_us,
                    "[PERF:WS] periodic metrics"
                );
                last_metrics_log = Instant::now();
            }
        }

        if frames_sent > 0 {
            let avg_latency = total_latency_us / frames_sent;
            tracing::info!(
                total_frames_sent = frames_sent,
                total_frames_lagged = frames_lagged,
                avg_latency_us = avg_latency,
                max_latency_us = max_latency_us,
                "[PERF:WS] session ended - final metrics"
            );
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
