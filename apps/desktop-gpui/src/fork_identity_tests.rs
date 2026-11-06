use crate::i18n::{LOCALE_ENV, init};
use crate::i18n_shipped::{Locale, tr};
use crate::installer::fetch_release;
use crate::store::UpdateChannel;

const BRANDED_KEYS: &[&str] = &[
    "camera.issue.access_message",
    "controls.low_storage",
    "dialog.capture.approve_shortcut",
    "dialog.capture.camera_notice",
    "dialog.capture.camera_notice_instant",
    "dialog.capture.shortcut_conflict",
    "dialog.capture.shortcut_description",
    "dialog.capture.tray_stop_hint",
    "dialog.delete_recording.finishing_body",
    "dialog.file.unconfirmed",
    "dialog.quit.canceled",
    "dialog.quit.pending",
    "dialog.quit.still_open",
    "dialog.quit.unconfirmed",
    "dialog.teleprompter.hidden",
    "dialog.update.already_getting",
    "dialog.update.available",
    "dialog.update.busy",
    "dialog.update.busy_title",
    "dialog.update.no_update",
    "dialog.update.ready",
    "dialog.update.title",
    "editor.panel.text_preset.sample.caption",
    "editor.tabs.captions.highlight_note",
    "editor.tabs.captions.keep_open",
    "editor.tabs.sync.auto_description",
    "main.device.access.camera_denied",
    "main.device.access.camera_needed",
    "main.device.access.microphone_denied",
    "main.device.access.microphone_needed",
    "main.recording.paused_notice",
    "main.sign_in.pending_message",
    "main.storage.can_start",
    "menu.app.about",
    "menu.app.hide",
    "menu.app.quit",
    "message.permission.unavailable",
    "message.recording.crashed_before_capture",
    "message.recording.low_storage_preserved",
    "message.recording.restart_hide_failed",
    "onboarding.customize.subtitle",
    "onboarding.customize.title",
    "onboarding.demo.editor",
    "onboarding.faq.free.answer",
    "onboarding.faq.free.question",
    "onboarding.faq.sharing.answer",
    "onboarding.faq.storage.answer",
    "onboarding.nav.continue_to_cap",
    "onboarding.nav.relaunch",
    "onboarding.nav.start",
    "onboarding.overview.subtitle",
    "onboarding.toggle.subtitle",
    "overlay.window.size_needs_accessibility_body",
    "permission.guide.title",
    "permission.onboarding.accessibility.body",
    "permission.onboarding.accessibility.title",
    "permission.onboarding.all_set.body",
    "permission.onboarding.all_set.regained",
    "permission.onboarding.camera.title",
    "permission.onboarding.checklist.regained_title",
    "permission.onboarding.checklist.title",
    "permission.onboarding.hint.drag_into_list",
    "permission.onboarding.hint.find_in_list",
    "permission.onboarding.hint.no_prompt",
    "permission.onboarding.hint.open_settings",
    "permission.onboarding.hint.turned_off",
    "permission.onboarding.microphone.title",
    "permission.onboarding.relaunch.body",
    "permission.onboarding.relaunch.hint",
    "permission.onboarding.relaunch.later",
    "permission.onboarding.screen.body",
    "permission.onboarding.screen.done_body",
    "permission.onboarding.screen.title",
    "permission.onboarding.switch_on_title",
    "screenshot_editor.error.sign_in_to_share",
    "settings.automations.compatibility_checked",
    "settings.automations.dangerous",
    "settings.automations.description",
    "settings.automations.template.ocr_screenshot.description",
    "settings.cli.description",
    "settings.feedback.community_description",
    "settings.feedback.debug_description",
    "settings.feedback.description",
    "settings.feedback.diagnostic.confirm_body",
    "settings.feedback.diagnostic.no_cli",
    "settings.feedback.diagnostic.no_cli_sync",
    "settings.feedback.diagnostic.send",
    "settings.feedback.diagnostic.warning_body",
    "settings.feedback.placeholder",
    "settings.general.app.description",
    "settings.general.app.dock_icon.description",
    "settings.general.app.notifications.description",
    "settings.general.appearance.description",
    "settings.general.excluded_windows.missing_title",
    "settings.general.language.description",
    "settings.general.privacy.telemetry.description",
    "settings.general.recording.delete_after_upload.description",
    "settings.general.self_host.description",
    "settings.general.self_host.server_url",
    "settings.general.storage.description",
    "settings.general.updates.channel.description",
    "settings.general.updates.description",
    "settings.general.updates.download_policy.description",
    "settings.integrations.description",
    "settings.integrations.gdrive.connection_description",
    "settings.integrations.google_drive_description",
    "settings.integrations.s3.guide_intro",
    "settings.license.desktop_description",
    "settings.license.explore_pro",
    "settings.license.sign_in_hint",
    "settings.options.post_studio.show_cap",
    "settings.quality.instant.free_plan",
    "settings.shortcuts.after_screenshot.hint",
    "settings.shortcuts.effect.open_picker",
    "settings.shortcuts.outcome.instant_show_cap",
    "settings.shortcuts.outcome.studio_show_cap",
    "settings.shortcuts.recording_description",
    "settings.shortcuts.sentence.open_picker",
    "tray.quit",
    "tray.tooltip_recording",
    "tray.version",
];

fn catalog_keys_naming_upstream() -> Vec<String> {
    let mut section = "";
    let mut keys = Vec::new();
    for line in include_str!("../locales/en.toml").lines() {
        if let Some(name) = line
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
        {
            section = name;
            continue;
        }
        let Some((name, value)) = line.split_once(" = ") else {
            continue;
        };
        let value = value.split(", context =").next().unwrap_or(value);
        if fork_brand::text(value) != value {
            keys.push(format!("{section}.{name}"));
        }
    }
    keys.sort();
    keys
}

#[test]
fn every_catalog_string_naming_cap_is_reviewed() {
    let mut reviewed: Vec<String> = BRANDED_KEYS
        .iter()
        .chain(fork_brand::KEEP_UPSTREAM_NAME)
        .map(|key| key.to_string())
        .collect();
    reviewed.sort();
    assert_eq!(
        catalog_keys_naming_upstream(),
        reviewed,
        "decide whether each new catalog string naming Cap is branded (BRANDED_KEYS) or names \
         upstream (fork_brand::KEEP_UPSTREAM_NAME)"
    );
}

#[test]
fn catalog_strings_carry_the_fork_name() {
    assert_eq!(tr::menu::app::quit(), fork_brand::text("Quit Cap"));
    assert_eq!(tr::tray::version("0.1.0"), fork_brand::text("Cap v0.1.0"));
    assert_eq!(
        tr::editor::clips::error::not_a_project(),
        "Select a Cap project folder"
    );
    assert_eq!(
        tr::onboarding::faq::free::question(),
        fork_brand::text("Is Cap free to use?")
    );
}

#[test]
fn no_locale_offers_cap_pro() {
    let tables = include_str!(concat!(env!("OUT_DIR"), "/i18n_shipped.rs"));
    for name in [fork_brand::UPSTREAM_NAME, fork_brand::APP_NAME] {
        assert!(!tables.contains(&format!("{name} Pro")), "{name} Pro");
    }
}

#[test]
fn fork_wording_reads_the_same_in_every_locale() {
    const CHILD: &str = "CAP_GPUI_TEST_FORK_WORDING_LOCALES";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "fork_identity_tests::fork_wording_reads_the_same_in_every_locale",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env_remove(LOCALE_ENV)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    for locale in Locale::ALL {
        if locale == Locale::Pseudo {
            continue;
        }
        init(Some(locale.code()));
        let code = locale.code();
        assert_eq!(
            tr::settings::feedback::diagnostic::send(),
            "Send to upstream",
            "{code}"
        );
        assert_eq!(
            tr::onboarding::faq::free::question(),
            fork_brand::text("Is Cap free to use?"),
            "{code}"
        );
        assert_eq!(
            tr::main::sign_in::pending_message(),
            format!(
                "Finish signing in to {} in your browser. {} returns to the recorder when you're done.",
                fork_brand::UPSTREAM_NAME,
                fork_brand::APP_NAME
            ),
            "{code}"
        );
        assert_eq!(
            tr::settings::shortcuts::sentence::cycle_mode(),
            format!(
                "Switch between Studio, Instant, Screenshot and {}.",
                fork_brand::WALK_MODE_NAME
            ),
            "{code}"
        );
        for branded in [tr::menu::app::about(), tr::tray::quit()] {
            assert!(branded.contains(fork_brand::APP_NAME), "{code}: {branded}");
        }
    }
    init(Some(Locale::En.code()));
    assert_eq!(tr::menu::app::about(), fork_brand::text("About Cap"));
}

#[test]
fn saved_window_rules_follow_a_rename() {
    let shipped = fork_brand::text_static;
    let current = shipped("Cap Settings");
    assert!(current.contains(fork_brand::APP_NAME));
    assert_eq!(
        crate::fork_titles::current_title_among("Cap Settings", shipped),
        Some(current)
    );
    for former in fork_brand::former_names() {
        assert_eq!(
            crate::fork_titles::current_title_among(&format!("{former} Settings"), shipped),
            Some(current)
        );
    }
    assert_eq!(
        crate::fork_titles::current_title_among("Finder", shipped),
        None
    );
}

#[test]
fn fork_keeps_its_own_identity() {
    assert_eq!(crate::store::APP_IDENTIFIER, fork_brand::BUNDLE_ID);
    assert_eq!(crate::menus::APP_NAME, fork_brand::APP_NAME);
    assert!(
        crate::store::app_data_dir().ends_with(fork_brand::BUNDLE_ID)
            || std::env::var_os("CAP_GPUI_APP_DATA_DIR").is_some()
    );
}

#[tokio::test]
async fn fork_refuses_official_update_resolution() {
    let error = fetch_release(UpdateChannel::Stable, &semver::Version::new(0, 6, 1))
        .await
        .unwrap_err();
    assert!(error.contains(fork_brand::RELEASES_URL));
}
