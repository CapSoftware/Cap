use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct TestStore {
    _directory: tempfile::TempDir,
}

impl TestStore {
    fn new(server: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        store::set_test_tauri_store_path(Some(directory.path().join("store")));
        assert!(store::set_store_setting(
            store::GENERAL_SETTINGS,
            "serverUrl",
            server.into()
        ));
        assert!(store::set_auth(Some(json!({
            "user_id": "original-user",
            "secret": { "api_key": "original-token" }
        }))));
        Self {
            _directory: directory,
        }
    }
}

impl Drop for TestStore {
    fn drop(&mut self) {
        store::TEST_AFTER_AUTH_SNAPSHOT.with(|hook| hook.take());
        store::set_test_tauri_store_path(None);
    }
}

#[tokio::test]
async fn server_change_keeps_an_in_flight_requests_token_on_its_original_server() {
    let original = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let other = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let original_url = format!("http://{}", original.local_addr().unwrap());
    let other_url = format!("http://{}", other.local_addr().unwrap());
    let _store = TestStore::new(&original_url);
    store::TEST_AFTER_AUTH_SNAPSHOT.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            assert!(sign_out());
            assert!(store::set_store_setting(
                store::GENERAL_SETTINGS,
                "serverUrl",
                other_url.into()
            ));
        }));
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let receive = async {
        let (accepted, destination) = tokio::select! {
            accepted = original.accept() => (accepted, "original"),
            accepted = other.accept() => (accepted, "other"),
        };
        let (mut stream, _) = accepted.unwrap();
        let mut headers = Vec::new();
        loop {
            let byte = stream.read_u8().await.unwrap();
            headers.push(byte);
            if headers.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        (destination, String::from_utf8(headers).unwrap())
    };
    let (response, (destination, headers)) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            authed_request_with(&client, reqwest::Method::GET, "/api/desktop/plan", None),
            receive
        )
    })
    .await
    .unwrap();
    assert!(response.unwrap().status().is_success());
    assert!(headers.contains("authorization: Bearer original-token\r\n"));
    assert_eq!(destination, "original");
    assert_ne!(server_url(), original_url);
    assert!(matches!(
        authed_request_with(&client, reqwest::Method::GET, "/api/desktop/plan", None).await,
        Err(AuthApiError::InvalidAuthentication)
    ));
}
