use std::{pin::pin, sync::Arc, task::Poll};

use futures::{FutureExt, SinkExt, StreamExt};

// TODO: Possibly replace this with ffmpeg's network outputs in the pipeline somehow?
// pub async fn create_camera_ws(frame_rx: CameraFrameReceiver) -> u16 {
//     use axum::{
//         extract::{
//             ws::{Message, WebSocket, WebSocketUpgrade},
//             State,
//         },
//         response::IntoResponse,
//         routing::get,
//     };
//     use tokio::sync::Mutex;

//     type RouterState = Arc<Mutex<CameraFrameReceiver>>;

//     async fn ws_handler(
//         ws: WebSocketUpgrade,
//         State(state): State<RouterState>,
//     ) -> impl IntoResponse {
//         ws.on_upgrade(move |socket| handle_socket(socket, state))
//     }

//     async fn handle_socket(socket: WebSocket, state: RouterState) {
//         let camera_rx = state.lock().await;
//         println!("socket connection established");
//         tracing::info!("Socket connection established");
//         let now = std::time::Instant::now();

//         let (mut socket_sink, mut socket_stream) = socket.split();

//         let mut stream = futures::stream::poll_fn(|cx| {
//             if let Poll::Ready(_) = socket_stream.poll_next_unpin(cx) {
//                 tracing::info!("Received message from socket");
//                 return Poll::Ready(None);
//             };

//             camera_rx.recv_async().poll_unpin(cx).map(|v| Some(v))
//         });

//         while let Some(incoming_frame) = stream.next().await {
//             match incoming_frame {
//                 Ok(mut frame) => {
//                     frame
//                         .data
//                         .extend_from_slice(&(frame.width * 4).to_le_bytes());
//                     frame.data.extend_from_slice(&frame.height.to_le_bytes());
//                     frame.data.extend_from_slice(&frame.width.to_le_bytes());

//                     tracing::info!("Received frame from camera");
//                     if let Err(e) = socket_sink.send(Message::Binary(frame.data)).await {
//                         tracing::error!("Failed to send frame to socket: {:?}", e);
//                         break;
//                     }
//                 }
//                 Err(e) => {
//                     tracing::warn!(
//                         "Connection has been lost! Shutting down camera server: {:?}",
//                         e
//                     );
//                     break;
//                 }
//             }
//         }

//         let elapsed = now.elapsed();
//         println!("Websocket closing after {elapsed:.2?}");
//         tracing::info!("Websocket closing after {elapsed:.2?}");
//     }

//     let router = axum::Router::new()
//         .route("/", get(ws_handler))
//         .with_state(Arc::new(Mutex::new(frame_rx)));

//     let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
//     let port = listener.local_addr().unwrap().port();
//     tracing::info!("WebSocket server listening on port {}", port);
//     tokio::spawn(async move {
//         axum::serve(listener, router.into_make_service())
//             .await
//             .unwrap();
//     });

//     port
// }
