use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use cap_desktop_lib::{App, web_api::ManagerExt};
use tauri::{Manager, test::mock_app};
use tokio::sync::RwLock;

#[test]
fn make_app_url_before_manage_does_not_panic_and_uses_default_server_url() {
    let app = mock_app();
    let handle = app.handle().clone();

    let raw_state_access = catch_unwind(AssertUnwindSafe(|| {
        let _ = handle.state::<Arc<RwLock<App>>>();
    }));

    assert!(raw_state_access.is_err());

    let url = futures::executor::block_on(handle.make_app_url("/api/upload/multipart/initiate"));

    assert_eq!(
        url,
        format!(
            "{}{}",
            option_env!("VITE_SERVER_URL").unwrap_or("https://cap.so"),
            "/api/upload/multipart/initiate"
        )
    );

    std::mem::forget(app);
}

#[test]
fn is_server_url_custom_before_manage_is_safe_and_false() {
    let app = mock_app();
    let handle = app.handle().clone();

    let is_custom = futures::executor::block_on(handle.is_server_url_custom());

    assert!(!is_custom);

    std::mem::forget(app);
}
