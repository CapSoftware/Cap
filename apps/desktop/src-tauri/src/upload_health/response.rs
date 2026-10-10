use super::UploadHealthProbeResponse;

// The response is a small receipt, not uploaded media. Bound it independently of
// the request timeout, including when the server omits Content-Length.
const MAX_RESPONSE_BYTES: usize = 8 * 1024;

#[derive(Debug, thiserror::Error)]
pub(super) enum ProbeResponseError {
    #[error("Upload health response exceeds {MAX_RESPONSE_BYTES} bytes")]
    TooLarge,
    #[error(transparent)]
    Transport(#[from] reqwest::Error),
    #[error(transparent)]
    InvalidJson(#[from] serde_json::Error),
}

pub(super) async fn read_probe_response(
    mut response: reqwest::Response,
) -> Result<UploadHealthProbeResponse, ProbeResponseError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(ProbeResponseError::TooLarge);
    }

    let mut body = Vec::with_capacity(MAX_RESPONSE_BYTES);
    while let Some(chunk) = response.chunk().await? {
        if chunk.len() > MAX_RESPONSE_BYTES - body.len() {
            return Err(ProbeResponseError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&body)?)
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::oneshot,
        task::JoinHandle,
    };

    use super::*;
    use crate::upload_health::{PROBE_PAYLOAD, PROBE_SHA256, lifecycle::ProbeControl};

    async fn serve(response: Vec<u8>, wait_for_disconnect: bool) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://{}/upload-health", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            socket.write_all(&response).await.unwrap();
            if wait_for_disconnect {
                let mut byte = [0];
                let result = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut byte))
                    .await
                    .expect("client should close the unfinished response");
                assert!(matches!(result, Ok(0) | Err(_)));
            }
        });
        (url, server)
    }

    async fn read_request(socket: &mut TcpStream) {
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            assert!(header.len() < 8192);
            header.push(socket.read_u8().await.unwrap());
        }
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    fn receipt(checksum: bool) -> Vec<u8> {
        let mut value = serde_json::json!({
            "success": true,
            "receivedBytes": PROBE_PAYLOAD.len(),
            "maxProbeBytes": 512 * 1024,
        });
        if checksum {
            value["sha256"] = serde_json::json!(PROBE_SHA256);
        }
        serde_json::to_vec(&value).unwrap()
    }

    #[tokio::test]
    async fn accepts_current_and_legacy_receipts_at_the_exact_size_boundary() {
        for checksum in [false, true] {
            let mut body = receipt(checksum);
            body.resize(MAX_RESPONSE_BYTES, b' ');
            let mut wire = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .into_bytes();
            wire.extend(body);
            let (url, server) = serve(wire, false).await;
            let response = client().get(url).send().await.unwrap();
            let parsed = read_probe_response(response).await.unwrap();
            assert!(parsed.success);
            assert_eq!(parsed.received_bytes, PROBE_PAYLOAD.len());
            assert_eq!(parsed.verifies_payload(), checksum);
            if !checksum {
                assert_eq!(
                    parsed.unverified_snapshot().unwrap().kind,
                    crate::upload_health::UploadHealthKind::Unsupported
                );
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn rejects_excessive_declared_length_without_waiting_for_body() {
        let wire = b"HTTP/1.1 200 OK\r\nContent-Length: 1000000000\r\n\r\n".to_vec();
        let (url, server) = serve(wire, true).await;
        let response = client().get(url).send().await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(3), read_probe_response(response))
            .await
            .expect("oversized length must reject before reading the body");
        assert!(matches!(result, Err(ProbeResponseError::TooLarge)));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_oversized_chunked_body_before_waiting_for_its_end() {
        let mut wire = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        for length in [4096, 4096, 1] {
            wire.extend(format!("{length:X}\r\n").as_bytes());
            wire.extend(vec![b' '; length]);
            wire.extend(b"\r\n");
        }
        // Deliberately omit the terminal chunk. Rejection must drop the stream.
        let (url, server) = serve(wire, true).await;
        let response = client().get(url).send().await.unwrap();
        assert_eq!(response.content_length(), None);
        let result = tokio::time::timeout(Duration::from_secs(3), read_probe_response(response))
            .await
            .expect("byte cap must not wait for an unlimited response to finish");
        assert!(matches!(result, Err(ProbeResponseError::TooLarge)));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_invalid_json_and_truncated_receipts() {
        for body in [b"not json".to_vec(), b"{\"success\":true,".to_vec()] {
            let mut wire = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .into_bytes();
            wire.extend(body);
            let (url, server) = serve(wire, false).await;
            let response = client().get(url).send().await.unwrap();
            assert!(matches!(
                read_probe_response(response).await,
                Err(ProbeResponseError::InvalidJson(_))
            ));
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn rejects_early_http_eof_even_when_the_partial_body_is_valid_json() {
        let body = receipt(true);
        let mut wire = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len() + 10
        )
        .into_bytes();
        wire.extend(body);
        let (url, server) = serve(wire, false).await;
        let response = client().get(url).send().await.unwrap();
        assert!(matches!(
            read_probe_response(response).await,
            Err(ProbeResponseError::Transport(_))
        ));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn retains_request_deadline_while_reading_a_partial_response() {
        let wire = b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{".to_vec();
        let (url, server) = serve(wire, true).await;
        let response = client()
            .get(url)
            .timeout(Duration::from_secs(1))
            .send()
            .await
            .unwrap();
        let result = tokio::time::timeout(Duration::from_secs(3), read_probe_response(response))
            .await
            .expect("the original request deadline must cover response chunks");
        assert!(matches!(result, Err(ProbeResponseError::Transport(error)) if error.is_timeout()));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn recording_cancels_an_incomplete_streaming_receipt() {
        let wire = b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{".to_vec();
        let (url, server) = serve(wire, true).await;
        let control = Arc::new(ProbeControl::default());
        let probe_control = Arc::clone(&control);
        let (streaming_tx, streaming_rx) = oneshot::channel();
        let probe = tokio::spawn(async move {
            let mut active = probe_control.try_start().unwrap();
            active
                .run(async {
                    let response = client().get(url).send().await.unwrap();
                    streaming_tx.send(()).unwrap();
                    read_probe_response(response).await
                })
                .await
        });
        tokio::time::timeout(Duration::from_secs(3), async {
            streaming_rx.await.unwrap();
            control.cancel_and_wait().await;
            assert!(probe.await.unwrap().is_none());
            assert!(control.try_start().is_some());
            server.await.unwrap();
        })
        .await
        .expect("recording must not wait for an incomplete JSON receipt");
    }
}
