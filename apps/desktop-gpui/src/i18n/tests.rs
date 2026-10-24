use super::*;

#[test]
fn english_is_the_default_locale() {
    assert_eq!(Locale::ALL[index()], Locale::En);
    assert_eq!(Locale::En.code(), "en");
    assert_eq!(Locale::from_code("en"), Some(Locale::En));
}

#[test]
fn english_matches_the_literals_it_replaced() {
    let app_name = crate::menus::APP_NAME;
    let pairs: &[(&str, String)] = &[
        (tr::common::add(), "Add".into()),
        (tr::common::cancel(), "Cancel".into()),
        (tr::common::ok(), "OK".into()),
        (tr::common::reset(), "Reset".into()),
        (tr::common::reset_to_default(), "Reset to Default".into()),
        (tr::common::save(), "Save".into()),
        (tr::menu::app::about(), format!("About {app_name}")),
        (tr::menu::app::hide(), format!("Hide {app_name}")),
        (tr::menu::app::hide_others(), "Hide Others".into()),
        (tr::menu::app::quit(), format!("Quit {app_name}")),
        (tr::menu::app::services(), "Services".into()),
        (tr::menu::app::settings(), "Settings…".into()),
        (tr::menu::file::close_window(), "Close Window".into()),
        (tr::menu::file::title(), "File".into()),
        (tr::menu::edit::copy(), "Copy".into()),
        (tr::menu::edit::cut(), "Cut".into()),
        (tr::menu::edit::paste(), "Paste".into()),
        (tr::menu::edit::redo(), "Redo".into()),
        (tr::menu::edit::select_all(), "Select All".into()),
        (tr::menu::edit::title(), "Edit".into()),
        (tr::menu::edit::undo(), "Undo".into()),
        (
            tr::menu::view::enter_full_screen(),
            "Enter Full Screen".into(),
        ),
        (tr::menu::view::title(), "View".into()),
        (tr::menu::window::close_window(), "Close Window".into()),
        (tr::menu::window::minimize(), "Minimize".into()),
        (tr::menu::window::zoom(), "Zoom".into()),
        (tr::menu::help::title(), "Help".into()),
        (tr::tray::import_media(), "Import Media...".into()),
        (tr::tray::no_recent_items(), "No recent items".into()),
        (tr::tray::open_main_window(), "Open Main Window".into()),
        (tr::tray::previous(), "Previous".into()),
        (tr::tray::quit(), "Quit Cap".into()),
        (tr::tray::record_area(), "Record Area".into()),
        (tr::tray::record_display(), "Record Display".into()),
        (tr::tray::record_window(), "Record Window".into()),
        (
            tr::tray::request_permissions(),
            "Request Permissions".into(),
        ),
        (tr::tray::screenshot_area(), "Screenshot Area".into()),
        (tr::tray::screenshot_display(), "Screenshot Display".into()),
        (tr::tray::screenshot_window(), "Screenshot Window".into()),
        (tr::tray::select_mode(), "Select Mode".into()),
        (tr::tray::settings(), "Settings".into()),
        (tr::tray::take_screenshot(), "Take a Screenshot".into()),
        (tr::tray::tooltip_recording(), "Cap - Stop Recording".into()),
        (tr::tray::upload_logs(), "Upload Logs".into()),
        (
            tr::tray::view_all_recordings(),
            "View all recordings".into(),
        ),
        (
            tr::tray::view_all_screenshots(),
            "View all screenshots".into(),
        ),
        (tr::tray::mode::instant(), "Instant".into()),
        (tr::tray::mode::screenshot(), "Screenshot".into()),
        (tr::tray::mode::studio(), "Studio".into()),
        (tr::settings::nav::automations(), "Automations".into()),
        (tr::settings::nav::changelog(), "Changelog".into()),
        (tr::settings::nav::cli(), "CLI".into()),
        (tr::settings::nav::experimental(), "Experimental".into()),
        (tr::settings::nav::feedback(), "Feedback".into()),
        (tr::settings::nav::general(), "General".into()),
        (tr::settings::nav::integrations(), "Integrations".into()),
        (tr::settings::nav::license(), "Plan & license".into()),
        (tr::settings::nav::quality(), "Recording quality".into()),
        (tr::settings::nav::recordings(), "Recordings".into()),
        (tr::settings::nav::screenshots(), "Screenshots".into()),
        (tr::settings::nav::shortcuts(), "Shortcuts".into()),
        (tr::settings::nav::transcription(), "Transcription".into()),
        (
            tr::settings::general::appearance::description(),
            "Match Cap to your system theme or pick a fixed look.".into(),
        ),
        (
            tr::settings::general::appearance::title(),
            "Appearance".into(),
        ),
        (
            tr::settings::general::app::description(),
            "Choose how Cap shows up on your system.".into(),
        ),
        (tr::settings::general::app::title(), "App".into()),
        (
            tr::settings::general::app::dock_icon::description(),
            "Keep Cap in the dock even when no windows are open.".into(),
        ),
        (
            tr::settings::general::app::dock_icon::label(),
            "Always show dock icon".into(),
        ),
        (
            tr::settings::general::app::notifications::description(),
            "Show notifications for clipboard copies, saved files, and more. \
                             You may need to allow Cap in your system's notification settings."
                .into(),
        ),
        (
            tr::settings::general::app::notifications::label(),
            "System notifications".into(),
        ),
        (
            tr::settings::general::recording::description(),
            "Behaviour while you record and after you stop.".into(),
        ),
        (
            tr::settings::general::recording::title(),
            "Recording".into(),
        ),
        (
            tr::settings::general::recording::countdown::description(),
            "Wait before the recording starts.".into(),
        ),
        (
            tr::settings::general::recording::countdown::label(),
            "Countdown".into(),
        ),
        (
            tr::settings::general::recording::countdown::off(),
            "Off".into(),
        ),
        (
            tr::settings::general::recording::countdown::seconds_10(),
            "10 seconds".into(),
        ),
        (
            tr::settings::general::recording::countdown::seconds_3(),
            "3 seconds".into(),
        ),
        (
            tr::settings::general::recording::countdown::seconds_5(),
            "5 seconds".into(),
        ),
        (
            tr::settings::general::recording::confirm_without_mic::description(),
            "Require confirmation when no microphone is selected or the \
                             selected microphone is unavailable."
                .into(),
        ),
        (
            tr::settings::general::recording::confirm_without_mic::label(),
            "Confirm before recording without a microphone".into(),
        ),
        (
            tr::settings::general::recording::studio_sound::description(),
            "Clean up microphone audio automatically. You can still turn it \
                             off for any recording in the editor."
                .into(),
        ),
        (
            tr::settings::general::recording::studio_sound::label(),
            "Studio Sound on new recordings".into(),
        ),
        (
            tr::settings::general::recording::main_window_start::description(),
            "What happens to the main window once a recording begins.".into(),
        ),
        (
            tr::settings::general::recording::main_window_start::label(),
            "Main window when recording starts".into(),
        ),
        (
            tr::settings::general::recording::post_deletion::description(),
            "Whether the recording window should reopen.".into(),
        ),
        (
            tr::settings::general::recording::post_deletion::label(),
            "After deleting a recording".into(),
        ),
        (
            tr::settings::general::recording::delete_after_upload::description(),
            "Cap removes the local file once it has uploaded successfully.".into(),
        ),
        (
            tr::settings::general::recording::delete_after_upload::label(),
            "Delete Instant recordings after upload".into(),
        ),
        (
            tr::settings::general::recording::crash_recovery::description(),
            "Record in fragments that can be recovered after a crash or power \
                             loss. Slightly larger files during capture."
                .into(),
        ),
        (
            tr::settings::general::recording::crash_recovery::label(),
            "Crash-recoverable recording".into(),
        ),
        (
            tr::settings::general::recording::custom_cursor::description(),
            "Capture cursor state separately so you can adjust size and \
                             smoothing in the editor."
                .into(),
        ),
        (
            tr::settings::general::recording::custom_cursor::label(),
            "Custom cursor capture (Studio)".into(),
        ),
        (
            tr::settings::general::recording::auto_zoom::description(),
            "Automatically add zoom segments around mouse clicks in Studio \
                             recordings."
                .into(),
        ),
        (
            tr::settings::general::recording::auto_zoom::label(),
            "Auto zoom on clicks".into(),
        ),
        (
            tr::settings::general::recording::default_zoom::description(),
            "Zoom level for newly created and auto-generated zoom segments.".into(),
        ),
        (
            tr::settings::general::recording::default_zoom::label(),
            "Default zoom amount".into(),
        ),
        (
            tr::settings::general::recording::capture_keyboard::description(),
            "Record key presses so you can add keyboard overlays in the editor.".into(),
        ),
        (
            tr::settings::general::recording::capture_keyboard::label(),
            "Capture keyboard presses".into(),
        ),
        (
            tr::settings::general::recording::notch_overlay::description(),
            "Automatically restores the notch for new screen and area \
                             recordings when the selected region contains the complete notch. \
                             External displays, partial areas, and window recordings are left \
                             alone. Each recording can override it in the editor."
                .into(),
        ),
        (
            tr::settings::general::recording::notch_overlay::label(),
            "Draw the MacBook notch on screen recordings".into(),
        ),
        (
            tr::settings::general::recording::max_fps::description(),
            "Maximum framerate for screen capture.".into(),
        ),
        (
            tr::settings::general::recording::max_fps::description_high(),
            "Maximum framerate for screen capture. Higher values may cause \
                             drops or increased CPU usage on some systems."
                .into(),
        ),
        (
            tr::settings::general::recording::max_fps::fps_120(),
            "120 FPS".into(),
        ),
        (
            tr::settings::general::recording::max_fps::fps_24(),
            "24 FPS".into(),
        ),
        (
            tr::settings::general::recording::max_fps::fps_25(),
            "25 FPS".into(),
        ),
        (
            tr::settings::general::recording::max_fps::fps_30(),
            "30 FPS".into(),
        ),
        (
            tr::settings::general::recording::max_fps::fps_60(),
            "60 FPS (Recommended)".into(),
        ),
        (
            tr::settings::general::recording::max_fps::label(),
            "Max capture framerate".into(),
        ),
        (
            tr::settings::general::storage::choose_folder(),
            "Choose Folder".into(),
        ),
        (
            tr::settings::general::storage::default_location(),
            "Default (Application Support)".into(),
        ),
        (
            tr::settings::general::storage::description(),
            "Where Cap saves your recordings.".into(),
        ),
        (tr::settings::general::storage::title(), "Storage".into()),
        (
            tr::settings::general::project_name::available_placeholders(),
            "Available placeholders".into(),
        ),
        (
            tr::settings::general::project_name::description(),
            "Template used for new recordings and exported files.".into(),
        ),
        (
            tr::settings::general::project_name::title(),
            "Default project name".into(),
        ),
        (
            tr::settings::general::project_name::placeholders::date_time(),
            "Date & time".into(),
        ),
        (
            tr::settings::general::project_name::placeholders::date_values(),
            "the recording's date".into(),
        ),
        (
            tr::settings::general::project_name::placeholders::mode_values(),
            "\"studio\", \"instant\", or \"screenshot\"".into(),
        ),
        (
            tr::settings::general::project_name::placeholders::random(),
            "Random".into(),
        ),
        (
            tr::settings::general::project_name::placeholders::random_values(),
            "10 filename-safe hexadecimal characters; use {random:N} for 1–32.".into(),
        ),
        (
            tr::settings::general::project_name::placeholders::recording_mode(),
            "Recording mode".into(),
        ),
        (
            tr::settings::general::project_name::placeholders::recording_mode_values(),
            "\"Studio\", \"Instant\", or \"Screenshot\"".into(),
        ),
        (
            tr::settings::general::project_name::placeholders::target(),
            "Target".into(),
        ),
        (
            tr::settings::general::project_name::placeholders::target_kind_values(),
            "\"Display\", \"Window\", or \"Area\"".into(),
        ),
        (
            tr::settings::general::project_name::placeholders::target_name_values(),
            "Monitor name or window title.".into(),
        ),
        (
            tr::settings::general::project_name::placeholders::time_values(),
            "the recording's time".into(),
        ),
        (
            tr::settings::general::excluded_windows::description(),
            "Hide windows from recordings.".into(),
        ),
        (
            tr::settings::general::excluded_windows::empty(),
            "No windows are currently excluded.".into(),
        ),
        (
            tr::settings::general::excluded_windows::missing_title(),
            "Recommended Cap windows are not excluded".into(),
        ),
        (
            tr::settings::general::excluded_windows::restore(),
            "Restore".into(),
        ),
        (
            tr::settings::general::excluded_windows::title(),
            "Excluded windows".into(),
        ),
        (
            tr::settings::general::updates::description(),
            "Choose which Cap builds you receive.".into(),
        ),
        (
            tr::settings::general::updates::nightly_description(),
            "The newest builds, updated automatically in the background when you're \
         not recording or exporting. May be unstable."
                .into(),
        ),
        (
            tr::settings::general::updates::nightly_switch_back(),
            "Switching back to Stable will return you to the latest \
                                     stable version, which may be older than your current build."
                .into(),
        ),
        (
            tr::settings::general::updates::stable_description(),
            "Versioned releases (recommended)".into(),
        ),
        (tr::settings::general::updates::title(), "Updates".into()),
        (
            tr::settings::general::updates::channel::description(),
            "Which release channel Cap updates from.".into(),
        ),
        (
            tr::settings::general::updates::channel::label(),
            "Update channel".into(),
        ),
        (
            tr::settings::general::self_host::description(),
            "Only change this if you are running your own instance of Cap Web.".into(),
        ),
        (
            tr::settings::general::self_host::server_url(),
            "Cap Server URL".into(),
        ),
        (
            tr::settings::general::self_host::title(),
            "Self-host".into(),
        ),
        (tr::settings::general::self_host::update(), "Update".into()),
        (tr::settings::general::privacy::title(), "Privacy".into()),
        (
            tr::settings::general::privacy::telemetry::description(),
            "Cap uses anonymous telemetry to improve reliability and fix bugs. We \
                         never collect recording contents, window titles, file paths, or \
                         personal information."
                .into(),
        ),
        (
            tr::settings::general::privacy::telemetry::label(),
            "Share anonymous telemetry".into(),
        ),
    ];
    for (translated, literal) in pairs {
        assert_eq!(*translated, literal.as_str());
    }
    let plain_keys = KEYS.len() - 3;
    assert_eq!(
        pairs.len(),
        plain_keys,
        "every plain key has a literal above"
    );
}

#[test]
fn english_messages_format_like_the_literals_they_replaced() {
    let version = "0.6.1";
    assert_eq!(tr::tray::version(version), format!("Cap v{version}"));
    let names = "Cap Camera, Cap Settings".to_string();
    assert_eq!(
        tr::settings::general::excluded_windows::missing_body(&names),
        format!(
            "Camera, settings, or recording windows can appear as black \
                                 boxes in screen recordings. Missing: {names}."
        )
    );
    let origin = "https://cap.example.com";
    assert_eq!(
        tr::settings::general::self_host::confirm_change(origin),
        format!(
            "Are you sure you want to change the server URL to '{origin}'? You will need \
                 to sign in again."
        )
    );
}

#[test]
fn prompt_buttons_keep_their_roles() {
    assert_eq!(
        gpui::PromptButton::ok(tr::common::ok()),
        gpui::PromptButton::from("Ok")
    );
    assert_eq!(
        gpui::PromptButton::cancel(tr::common::cancel()),
        gpui::PromptButton::from("Cancel")
    );
}

#[test]
fn every_key_is_used_outside_the_catalog() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let i18n = src.join("i18n");
    let mut sources = String::new();
    let mut pending = vec![src];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                if path != i18n {
                    pending.push(path);
                }
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                sources.push_str(&std::fs::read_to_string(&path).unwrap());
                sources.push('\n');
            }
        }
    }
    let unused: Vec<&str> = KEYS
        .iter()
        .copied()
        .filter(|key| {
            let accessor = format!("tr::{}", key.replace('.', "::"));
            !sources.match_indices(&accessor).any(|(at, _)| {
                sources[at + accessor.len()..]
                    .chars()
                    .next()
                    .is_none_or(|next| !(next.is_ascii_alphanumeric() || next == '_'))
            })
        })
        .collect();
    assert!(
        unused.is_empty(),
        "keys in locales/en.toml that no code reads: {unused:?}"
    );
}
