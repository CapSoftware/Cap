use std::sync::Arc;

use cap_media::feeds::CameraFrameReceiver;

// TODO: Possibly replace this with ffmpeg's network outputs in the pipeline somehow?
pub async fn create_camera_ws(frame_rx: CameraFrameReceiver) -> u16 {
    use axum::{
        extract::{
            ws::{Message, WebSocket, WebSocketUpgrade},
            State,
        },
        response::IntoResponse,
        routing::get,
    };
    use tokio::sync::Mutex;

    type RouterState = Arc<Mutex<CameraFrameReceiver>>;

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
                }
                incoming_frame = camera_rx.recv_async() => {
                    match incoming_frame {
                        Ok(data) => {
                            tracing::info!("Received frame from camera");
                            if let Err(e) = socket.send(Message::Binary(data)).await {
                                tracing::error!("Failed to send frame to socket: {:?}", e);
                                break;
                            }
                        },
                        Err(e) => {
                            tracing::warn!("Connection has been lost! Shutting down camera server: {:?}", e);
                            break;
                        },
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
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service())
            .await
            .unwrap();
    });

    port
}
