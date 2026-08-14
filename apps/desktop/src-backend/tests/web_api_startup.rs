use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use cap_desktop_lib::{App, web_api::ManagerExt};
use cap_desktop_runtime::{AppHandle, AppPaths};
use tokio::sync::RwLock;

fn mock_app() -> AppHandle {
    let (outbound, _messages) = tokio::sync::mpsc::unbounded_channel();
    let paths = AppPaths::discover("so.cap.desktop.test", std::env::temp_dir()).unwrap();
    AppHandle::new(outbound, paths)
}

#[test]
fn make_app_url_before_manage_does_not_panic_and_uses_default_server_url() {
    let handle = mock_app();

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
}

#[test]
fn is_server_url_custom_before_manage_is_safe_and_false() {
    let handle = mock_app();

    let is_custom = futures::executor::block_on(handle.is_server_url_custom());

    assert!(!is_custom);
}
