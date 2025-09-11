use std::time::Duration;
use tauri::App;

pub fn setup_test_app() -> App {
    let app = tauri::test::mock_app();
    // Any additional setup for the app can go here
    app
}

pub async fn wait_for_event<F, Fut>(app: &App, event_name: &str, trigger: F)
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let mut rx = app.listen_global(event_name, |event| {
        println!("Received event: {:?}", event);
    });

    trigger().await;

    let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("event was not received")
        .expect("channel was closed");

    assert!(event.is_some(), "event was not received");
}
