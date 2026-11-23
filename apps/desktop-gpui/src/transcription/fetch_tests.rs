use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::fetch::{self, Patience, Progress};

const BODY: &[u8] = b"0123456789";

/// How one connection is answered, given its request.
#[derive(Clone, Copy)]
enum Reply {
    /// 200 for the whole body, but only `n` bytes before the connection drops.
    Drop(usize),
    /// 200 for the whole body, `n` bytes, then nothing (the connection stays).
    Stall(usize),
    /// 206 from the requested range, or 200 when there was none.
    Honour,
    /// 200 with the whole body whatever was asked.
    Ignore,
    NotFound,
}

/// Answers connections in order with `replies`; returns the URL and every
/// request's Range header.
async fn server(replies: Vec<Reply>) -> (String, Arc<Mutex<Vec<Option<String>>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/model.bin", listener.local_addr().unwrap());
    let ranges = Arc::new(Mutex::new(Vec::new()));
    let seen = ranges.clone();
    tokio::spawn(async move {
        for reply in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 2048];
            let n = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..n]).to_lowercase();
            let from = request
                .lines()
                .find_map(|l| l.strip_prefix("range: bytes="))
                .map(|r| r.trim_end_matches('-').trim().to_string());
            seen.lock().unwrap().push(from.clone());
            let start: usize = from.as_deref().and_then(|f| f.parse().ok()).unwrap_or(0);
            let head = |status: &str, body: &[u8]| {
                format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
            };
            match reply {
                Reply::Drop(n) => {
                    socket
                        .write_all(head("200 OK", BODY).as_bytes())
                        .await
                        .unwrap();
                    socket.write_all(&BODY[..n]).await.unwrap();
                }
                Reply::Stall(n) => {
                    socket
                        .write_all(head("200 OK", BODY).as_bytes())
                        .await
                        .unwrap();
                    socket.write_all(&BODY[..n]).await.unwrap();
                    socket.flush().await.unwrap();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        drop(socket);
                    });
                    continue;
                }
                Reply::Honour if start > 0 => {
                    let body = &BODY[start..];
                    let head = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{}/{}\r\nConnection: close\r\n\r\n",
                        body.len(),
                        BODY.len() - 1,
                        BODY.len()
                    );
                    socket.write_all(head.as_bytes()).await.unwrap();
                    socket.write_all(body).await.unwrap();
                }
                Reply::Honour | Reply::Ignore => {
                    socket
                        .write_all(head("200 OK", BODY).as_bytes())
                        .await
                        .unwrap();
                    socket.write_all(BODY).await.unwrap();
                }
                Reply::NotFound => {
                    socket
                        .write_all(head("404 Not Found", b"").as_bytes())
                        .await
                        .unwrap();
                }
            }
            let _ = socket.shutdown().await;
        }
    });
    (url, ranges)
}

fn quick() -> Patience {
    Patience {
        stall: Duration::from_millis(300),
        attempts: 4,
        backoff: Duration::from_millis(5),
    }
}

/// Runs one part download into a fresh file; returns what landed on disk,
/// the result, and the byte count the progress callback ended on.
async fn fetch_into(url: &str, patience: Patience) -> (Vec<u8>, Result<u64, String>, i64) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("model.bin.downloading");
    let (mut file, have) = fetch::reopen(&path).unwrap();
    let mut counted = 0i64;
    let mut progress = |event: Progress<'_>| match event {
        Progress::Bytes(chunk) => counted += chunk.len() as i64,
        Progress::Rewound(bytes) => counted -= bytes as i64,
    };
    let result = fetch::part(url, &mut file, 0, have, patience, &mut progress).await;
    drop(file);
    (std::fs::read(&path).unwrap(), result, counted)
}

#[tokio::test]
async fn a_dropped_download_resumes_where_it_stopped() {
    let (url, ranges) = server(vec![Reply::Drop(4), Reply::Honour]).await;
    let (bytes, result, counted) = fetch_into(&url, quick()).await;
    assert_eq!(bytes, BODY);
    assert_eq!(result.unwrap(), 10);
    assert_eq!(counted, 10);
    assert_eq!(*ranges.lock().unwrap(), vec![None, Some("4".to_string())]);
}

#[tokio::test]
async fn a_server_that_ignores_the_range_writes_the_part_again() {
    let (url, ranges) = server(vec![Reply::Drop(4), Reply::Ignore]).await;
    let (bytes, result, counted) = fetch_into(&url, quick()).await;
    assert_eq!(bytes, BODY, "the first 4 bytes must not be kept twice");
    assert_eq!(result.unwrap(), 10);
    assert_eq!(counted, 10);
    assert_eq!(ranges.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_stalled_download_is_tried_again_from_where_it_stood() {
    let (url, ranges) = server(vec![Reply::Stall(3), Reply::Honour]).await;
    let (bytes, result, _) = fetch_into(&url, quick()).await;
    assert_eq!(bytes, BODY);
    assert_eq!(result.unwrap(), 10);
    assert_eq!(*ranges.lock().unwrap(), vec![None, Some("3".to_string())]);
}

#[tokio::test]
async fn a_missing_file_fails_at_once_without_retries() {
    let (url, ranges) = server(vec![Reply::NotFound, Reply::Honour]).await;
    let (_, result, _) = fetch_into(&url, quick()).await;
    assert!(result.unwrap_err().contains("404"));
    assert_eq!(ranges.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_download_that_keeps_dropping_gives_up_after_its_tries() {
    let (url, ranges) = server(vec![Reply::Drop(1), Reply::Drop(1), Reply::Drop(1)]).await;
    let patience = Patience {
        attempts: 3,
        ..quick()
    };
    let (_, result, _) = fetch_into(&url, patience).await;
    assert!(result.is_err());
    assert_eq!(ranges.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn an_interrupted_try_leaves_its_bytes_for_the_next_one() {
    let dir = tempfile::tempdir().unwrap();
    let staging = dir.path().join("model.onnx.downloading");
    let sha = {
        use sha2::Digest as _;
        sha2::Sha256::digest(BODY)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    let (url, _) = server(vec![Reply::Drop(6)]).await;
    let first = fetch::verified(&url, &staging, &sha, Some(10), &|_| {}).await;
    assert!(first.is_err());
    assert_eq!(
        std::fs::read(&staging).unwrap(),
        &BODY[..6],
        "an interrupted try keeps what arrived"
    );

    let (url, ranges) = server(vec![Reply::Honour]).await;
    let counted = std::sync::atomic::AtomicI64::new(0);
    fetch::verified(&url, &staging, &sha, Some(10), &|n| {
        counted.fetch_add(n, std::sync::atomic::Ordering::Relaxed);
    })
    .await
    .unwrap();
    assert_eq!(std::fs::read(&staging).unwrap(), BODY);
    assert_eq!(*ranges.lock().unwrap(), vec![Some("6".to_string())]);
    assert_eq!(counted.load(std::sync::atomic::Ordering::Relaxed), 10);
}

#[tokio::test]
async fn a_corrupt_download_is_removed_so_the_next_try_starts_again() {
    let dir = tempfile::tempdir().unwrap();
    let staging = dir.path().join("model.onnx.downloading");
    let (url, _) = server(vec![Reply::Honour]).await;
    let result = fetch::verified(&url, &staging, "not-the-hash", Some(10), &|_| {}).await;
    assert!(result.unwrap_err().contains("corrupt"));
    assert!(!staging.exists());
}

#[test]
fn sizes_read_as_people_say_them() {
    assert_eq!(fetch::size_label(1), "1 MB");
    assert_eq!(fetch::size_label(420_000_000), "420 MB");
    assert_eq!(fetch::size_label(1_000_000_000), "1.0 GB");
    assert_eq!(fetch::size_label(1_234_000_000), "1.3 GB");
}

#[tokio::test]
async fn a_one_part_whisper_model_resumes_its_staging_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("base.bin");
    std::fs::write(super::staging_path(&path), &BODY[..6]).unwrap();
    let (url, ranges) = server(vec![Reply::Honour]).await;
    super::write_whisper_parts("base", &[url.as_str()], &path, 10)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), BODY);
    assert_eq!(*ranges.lock().unwrap(), vec![Some("6".to_string())]);
    assert!(!super::staging_path(&path).exists());
}

#[tokio::test]
async fn a_whisper_model_of_the_wrong_size_is_never_installed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("base.bin");
    let (url, _) = server(vec![Reply::Honour]).await;
    let result = super::write_whisper_parts("base", &[url.as_str()], &path, 12).await;
    assert!(result.is_err());
    assert!(!path.exists());
    assert!(!super::staging_path(&path).exists());
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
#[test]
fn only_staged_files_no_longer_than_expected_resume() {
    let dir = tempfile::tempdir().unwrap();
    let files: &[(&str, &[&str])] = &[
        ("a.onnx", &["https://example.invalid/a.onnx"]),
        ("b.onnx", &["https://example.invalid/b.onnx"]),
        (
            "c.onnx",
            &[
                "https://example.invalid/c.part0",
                "https://example.invalid/c.part1",
            ],
        ),
        ("d.onnx", &["https://example.invalid/d.onnx"]),
    ];
    std::fs::write(dir.path().join("a.onnx"), b"1234").unwrap();
    std::fs::write(dir.path().join("b.onnx"), b"123456789").unwrap();
    std::fs::write(dir.path().join("c.onnx"), b"12").unwrap();
    let sizes = [
        ("a.onnx", 10),
        ("b.onnx", 5),
        ("c.onnx", 10),
        ("d.onnx", 10),
    ];
    // a resumes; b is longer than the model (starts again); c has parts of
    // unknown sizes (starts again); d was never started.
    assert_eq!(
        super::resumable_parakeet_bytes(dir.path(), files, &sizes),
        vec![4, 0, 0, 0]
    );
}
