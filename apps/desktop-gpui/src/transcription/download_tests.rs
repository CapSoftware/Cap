use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

async fn multipart_server() -> (
    [String; 2],
    oneshot::Receiver<()>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (waiting_tx, waiting_rx) = oneshot::channel();
    let (finish_tx, finish_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        let mut request = [0; 1024];
        assert!(first.read(&mut request).await.unwrap() > 0);
        first
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nfirst")
            .await
            .unwrap();
        drop(first);

        let (mut second, _) = listener.accept().await.unwrap();
        assert!(second.read(&mut request).await.unwrap() > 0);
        waiting_tx.send(()).unwrap();
        if finish_rx.await.is_ok() {
            second
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecond",
                )
                .await
                .unwrap();
        }
    });
    (
        [
            format!("http://{address}/part0"),
            format!("http://{address}/part1"),
        ],
        waiting_rx,
        finish_tx,
        server,
    )
}

#[tokio::test]
async fn interrupted_whisper_download_is_not_an_installed_model() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("medium.bin");
    let (urls, waiting, finish, server) = multipart_server().await;
    let parts = [urls[0].as_str(), urls[1].as_str()];
    let mut download = Box::pin(write_whisper_parts("medium", &parts, &path, 11));

    tokio::select! {
        result = &mut download => panic!("Download ended before the second part: {result:?}"),
        result = tokio::time::timeout(Duration::from_secs(5), waiting) => result.unwrap().unwrap(),
    }

    drop(download);
    drop(finish);
    server.await.unwrap();
    assert!(
        !path.exists(),
        "An interrupted download must not look installed"
    );

    assert_eq!(std::fs::read(staging_path(&path)).unwrap(), b"first");

    let (urls, waiting, finish, server) = multipart_server().await;
    let parts = [urls[0].as_str(), urls[1].as_str()];
    let retry = write_whisper_parts("medium", &parts, &path, 11);
    let complete = async move {
        waiting.await.unwrap();
        finish.send(()).unwrap();
        server.await.unwrap();
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(retry, complete)
    })
    .await
    .unwrap();
    result.unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"firstsecond");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[tokio::test]
async fn failed_whisper_download_does_not_replace_an_installed_model() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("medium.bin");
    std::fs::write(&path, b"installed").unwrap();
    let (urls, waiting, finish, server) = multipart_server().await;
    let parts = [urls[0].as_str(), urls[1].as_str()];
    let download = write_whisper_parts("medium", &parts, &path, 11);
    let fail = async move {
        waiting.await.unwrap();
        drop(finish);
        server.await.unwrap();
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(download, fail)
    })
    .await
    .unwrap();
    assert!(result.is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"installed");
}
