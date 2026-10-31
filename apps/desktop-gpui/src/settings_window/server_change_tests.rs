use super::*;

struct TestStore(tempfile::TempDir);

impl TestStore {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        store::set_test_tauri_store_path(Some(directory.path().join("store")));
        assert!(store::set_auth(Some(serde_json::json!({
            "user_id": "original-user",
            "secret": { "api_key": "original-token" },
            "plan": { "upgraded": true }
        }))));
        assert!(store::set_store_value(
            "user_profile",
            serde_json::json!({
                "userId": "original-user",
                "profile": { "name": "Original user", "email": null, "imageUrl": null }
            })
        ));
        Self(directory)
    }
}

impl Drop for TestStore {
    fn drop(&mut self) {
        store::set_test_tauri_store_path(None);
    }
}

fn settings(
    cx: &mut gpui::TestAppContext,
) -> (Entity<SettingsWindow>, &mut gpui::VisualTestContext) {
    cx.update(SignIn::init);
    let cx = cx.add_empty_window();
    let settings = cx.update(|window, cx| {
        cx.new(|cx| SettingsWindow::new_with_theme(Page::General, Theme::light(), window, cx))
    });
    (settings, cx)
}

#[gpui::test]
fn server_change_signs_out_before_using_the_new_server(cx: &mut gpui::TestAppContext) {
    let _store = TestStore::new();
    let (settings, cx) = settings(cx);
    settings.update_in(cx, |settings, window, cx| {
        assert!(settings.has_cap_pro);
        assert!(settings.user_profile.is_some());
        settings.confirm_server_url("https://other.example.com".into(), window, cx);
    });
    cx.simulate_prompt_answer(tr::common::ok());
    cx.run_until_parked();

    assert_eq!(crate::auth::server_url(), "https://other.example.com");
    assert!(!store::auth_snapshot().signed_in());
    assert!(store::store_section("user_profile").is_empty());
    settings.read_with(cx, |settings, _| {
        assert!(!settings.has_cap_pro);
        assert!(settings.user_profile.is_none());
    });
}

#[gpui::test]
fn server_change_cancels_a_pending_browser_sign_in(cx: &mut gpui::TestAppContext) {
    let _store = TestStore::new();
    assert!(crate::auth::sign_out());
    let (settings, cx) = settings(cx);
    settings.update_in(cx, |settings, window, cx| {
        SignIn::global(cx).update(cx, |sign_in, cx| sign_in.start(SignInOrigin::Settings, cx));
        settings.confirm_server_url("https://other.example.com".into(), window, cx);
    });
    cx.simulate_prompt_answer(tr::common::ok());
    cx.run_until_parked();

    settings.read_with(cx, |_, cx| {
        assert!(!SignIn::global(cx).read(cx).is_pending())
    });
    assert_eq!(crate::auth::server_url(), "https://other.example.com");
    assert!(!store::auth_snapshot().signed_in());
}

#[gpui::test]
fn cancelling_a_server_change_keeps_the_account(cx: &mut gpui::TestAppContext) {
    let _store = TestStore::new();
    let (settings, cx) = settings(cx);
    settings.update_in(cx, |settings, window, cx| {
        settings.confirm_server_url("https://other.example.com".into(), window, cx);
    });
    cx.simulate_prompt_answer(tr::common::cancel());
    cx.run_until_parked();

    assert_eq!(crate::auth::server_url(), DEFAULT_SERVER_URL);
    assert!(store::auth_snapshot().signed_in());
    settings.read_with(cx, |settings, _| {
        assert!(settings.has_cap_pro);
        assert!(settings.user_profile.is_some());
    });
}

#[gpui::test]
fn server_change_stops_when_sign_out_cannot_be_saved(cx: &mut gpui::TestAppContext) {
    let store = TestStore::new();
    let (settings, cx) = settings(cx);
    settings.update_in(cx, |settings, window, cx| {
        settings.confirm_server_url("https://other.example.com".into(), window, cx);
    });
    std::fs::write(store.0.path().join("store"), "corrupt settings").unwrap();
    cx.simulate_prompt_answer(tr::common::ok());
    cx.run_until_parked();

    settings.read_with(cx, |settings, _| {
        assert_eq!(settings.server_url, DEFAULT_SERVER_URL);
        assert_eq!(settings.settings.server_url, DEFAULT_SERVER_URL);
        assert!(settings.has_cap_pro);
        assert!(settings.user_profile.is_some());
    });
    assert_eq!(
        std::fs::read_to_string(store.0.path().join("store")).unwrap(),
        "corrupt settings"
    );
}
