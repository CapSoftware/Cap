use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct WSFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
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

        // Send the current frame immediately upon connection (if one exists)
        // This ensures the client doesn't wait for the next config change to see the image
        {
            let frame_opt = camera_rx.borrow().clone();
            if let Some(mut frame) = frame_opt {
                frame.data.extend_from_slice(&frame.stride.to_le_bytes());
                frame.data.extend_from_slice(&frame.height.to_le_bytes());
                frame.data.extend_from_slice(&frame.width.to_le_bytes());

                if let Err(e) = socket.send(Message::Binary(frame.data)).await {
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
                    if let Some(mut frame) = frame_opt {
                        frame.data.extend_from_slice(&frame.stride.to_le_bytes());
                        frame.data.extend_from_slice(&frame.height.to_le_bytes());
                        frame.data.extend_from_slice(&frame.width.to_le_bytes());

                        if let Err(e) = socket.send(Message::Binary(frame.data)).await {
                            tracing::error!("Failed to send frame to socket: {:?}", e);
                            break;
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
                        Ok(mut frame) => {
                            frame.data.extend_from_slice(&frame.stride.to_le_bytes());
                            frame.data.extend_from_slice(&frame.height.to_le_bytes());
                            frame.data.extend_from_slice(&frame.width.to_le_bytes());

                            if let Err(e) = socket.send(Message::Binary(frame.data)).await {
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
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            tracing::warn!("Missed {skipped} frames on websocket receiver");
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
