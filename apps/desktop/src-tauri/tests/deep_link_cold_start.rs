use std::{
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tauri::{Url, test::MockRuntime};
use tauri_plugin_deep_link::DeepLinkExt;

const CHILD_EXPECTED_URL: &str = "CAP_DEEP_LINK_TEST_EXPECTED_URL";
const LOGIN: &str = "cap-desktop://login?token=cold-start-fixture";
const MIXED_CASE_LOGIN: &str = "CaP-DeSkToP://login?token=cold-start-fixture";

fn check_plugin_startup(expected: &str) {
    let mut context = tauri::test::mock_context::<MockRuntime, _>(tauri::test::noop_assets());
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    context.config_mut().plugins = serde_json::from_value(config["plugins"].clone()).unwrap();
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_deep_link::init())
        .build(context)
        .unwrap();
    let expected = if expected.is_empty() {
        None
    } else {
        Some(vec![Url::parse(expected).unwrap()])
    };
    assert_eq!(app.deep_link().get_current().unwrap(), expected);
    let events = Arc::new(AtomicUsize::new(0));
    let received = events.clone();
    app.deep_link().on_open_url(move |_| {
        received.fetch_add(1, Ordering::SeqCst);
    });
    assert_eq!(events.load(Ordering::SeqCst), 0);
    assert_eq!(app.deep_link().get_current().unwrap(), expected);
}

fn main() {
    if let Ok(expected) = std::env::var(CHILD_EXPECTED_URL) {
        check_plugin_startup(&expected);
        return;
    }

    let executable = std::env::current_exe().unwrap();
    let expected_login = if cfg!(any(windows, target_os = "linux")) {
        LOGIN
    } else {
        ""
    };
    let cases = [
        ("sole login URL", vec![LOGIN], expected_login),
        ("mixed-case scheme", vec![MIXED_CASE_LOGIN], expected_login),
        ("plain launch", vec![], ""),
        ("ordinary argument", vec!["--ordinary"], ""),
        ("project path", vec!["recording.cap"], ""),
        ("multiple URLs", vec![LOGIN, LOGIN], ""),
        ("mixed arguments", vec!["--ordinary", LOGIN], ""),
        ("foreign scheme", vec!["https://example.com"], ""),
        ("malformed URL", vec!["cap-desktop://["], ""),
    ];
    for (name, args, expected) in cases {
        let mut command = Command::new(&executable);
        command.args(args).env(CHILD_EXPECTED_URL, expected);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{name}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        println!("cold-start plugin case passed: {name}");
    }
}
