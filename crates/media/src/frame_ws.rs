use std::sync::Arc;

use flume::Receiver;
use tokio::sync::mpsc;

pub struct WSFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
}

pub async fn create_frame_ws(frame_rx: Receiver<WSFrame>) -> (u16, mpsc::Sender<()>) {
    use axum::{
        extract::{
            ws::{Message, WebSocket, WebSocketUpgrade},
            State,
        },
        response::IntoResponse,
        routing::get,
    };
    use tokio::sync::Mutex;

    type RouterState = Arc<Mutex<Receiver<WSFrame>>>;

    async fn ws_handler(
        ws: WebSocketUpgrade,
        State(state): State<RouterState>,
    ) -> impl IntoResponse {
        ws.on_upgrade(move |socket| handle_socket(socket, state))
    }

    async fn handle_socket(mut socket: WebSocket, state: RouterState) {
        let camera_rx = state.lock().await;
        println!("socket connection established");
        tracing::info!("Socket connection established");
        let now = std::time::Instant::now();

        loop {
            tokio::select! {
                _ = socket.recv() => {
                    tracing::info!("Received message from socket");
                    break;
                },
                incoming_frame = camera_rx.recv_async() => {
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
                        Err(e) => {
                            tracing::error!(
                                "Connection has been lost! Shutting down websocket server: {:?}",
                                e
                            );
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
        .with_state(Arc::new(Mutex::new(frame_rx)));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tracing::info!("WebSocket server listening on port {}", port);
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

    tokio::spawn(async move {
        let server = axum::serve(listener, router.into_make_service());
        tokio::select! {
            _ = server => {},
            _ = shutdown_rx.recv() => {
                println!("WebSocket server shutting down");
            }
        }
    });

    (port, shutdown_tx)
}
