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
        (tr::menu::file::open_file(), "Open File…".into()),
        (tr::menu::file::open_recent(), "Open Recent".into()),
        (tr::menu::file::import_media(), "Import Media…".into()),
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
        (tr::menu::window::title(), "Window".into()),
        (tr::menu::window::zoom(), "Zoom".into()),
        (tr::menu::help::title(), "Help".into()),
        (tr::menu::help::feedback(), "Give Feedback…".into()),
        (tr::menu::help::changelog(), "Changelog".into()),
        (
            tr::menu::about::licensed(),
            "Licensed under AGPL-3.0".into(),
        ),
        (tr::menu::about::website(), "Website".into()),
        (tr::menu::about::commit(), "Commit".into()),
        (tr::menu::help::dashboard(), "Dashboard".into()),
        (tr::menu::help::documentation(), "Documentation".into()),
        (tr::menu::help::faq(), "FAQ".into()),
        (tr::menu::help::self_hosting(), "Self-hosting".into()),
        (tr::menu::help::help_center(), "Help Center".into()),
        (tr::menu::help::system_status(), "System Status".into()),
        (tr::menu::help::discord(), "Join Discord Community".into()),
        (tr::menu::update::check(), "Check for Update".into()),
        (tr::menu::update::download(), "Download update…".into()),
        (tr::menu::update::checking(), "Checking for Update…".into()),
        (
            tr::menu::update::downloading(),
            "Downloading update…".into(),
        ),
        (tr::menu::update::restart(), "Restart to update…".into()),
        (tr::tray::import_media(), "Import Media...".into()),
        (tr::tray::no_recent_items(), "No recent items".into()),
        (tr::tray::recording_mode(), "Recording Mode".into()),
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
        (tr::settings::general::appearance::system(), "System".into()),
        (tr::settings::general::appearance::light(), "Light".into()),
        (tr::settings::general::appearance::dark(), "Dark".into()),
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
            tr::settings::general::recording::window_capture::description(),
            "How a window recording captures the window you pick. Focused window records only \
             that window, centred and followed if it moves; Screen region records the area of \
             the screen it covers."
                .into(),
        ),
        (
            tr::settings::general::recording::window_capture::label(),
            "Window capture style".into(),
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
            tr::settings::general::updates::download_policy::label(),
            "Update downloads".into(),
        ),
        (
            tr::settings::general::updates::download_policy::description(),
            "Choose whether Cap downloads updates automatically.".into(),
        ),
        (
            tr::settings::general::updates::download_policy::manual(),
            "Ask first".into(),
        ),
        (
            tr::settings::general::updates::download_policy::auto(),
            "Auto".into(),
        ),
        (
            tr::settings::general::updates::download_policy::never(),
            "Never".into(),
        ),
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
    let plain_keys = KEYS
        .iter()
        .filter(|key| {
            !key.starts_with(NEW_IN_THE_LANGUAGE_PICKER)
                && !super::surface_tests::is_main_surface_key(key)
                && !super::settings_surface_tests::is_settings_surface_key(key)
        })
        .count()
        // `tray.version`, `excluded_windows.missing_body`, `self_host.confirm_change`,
        // `menu.update.badge_progress` and `menu.update.badge_version` take arguments.
        - 5;
    assert_eq!(
        pairs.len(),
        plain_keys,
        "every plain key has a literal above"
    );
}

const NEW_IN_THE_LANGUAGE_PICKER: &str = "settings.general.language.";

#[test]
fn appearance_labels_follow_language_changes_without_changing_saved_values() {
    use crate::store::{AppTheme, SettingsEnum};

    const CHILD: &str = "CAP_GPUI_TEST_APPEARANCE_LABELS";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "i18n::tests::appearance_labels_follow_language_changes_without_changing_saved_values",
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

    for (locale, labels) in [
        (Locale::En, ["System", "Light", "Dark"]),
        (Locale::ZhCn, ["跟随系统", "浅色", "深色"]),
        (Locale::Ja, ["システム", "ライト", "ダーク"]),
        (Locale::Fr, ["Système", "Clair", "Sombre"]),
        (Locale::Es, ["Sistema", "Claro", "Oscuro"]),
        (Locale::De, ["System", "Hell", "Dunkel"]),
        (Locale::Hi, ["सिस्टम", "लाइट", "डार्क"]),
        (Locale::En, ["System", "Light", "Dark"]),
    ] {
        init(Some(locale.code()));
        for ((theme, label), saved) in AppTheme::ALL
            .iter()
            .zip(labels)
            .zip(["system", "light", "dark"])
        {
            assert_eq!(theme.label(), label, "{} {saved}", locale.code());
            assert_eq!(theme.as_json(), saved);
            assert_eq!(AppTheme::from_json(saved), Some(*theme));
        }
    }
}

#[test]
fn language_picker_english() {
    assert_eq!(tr::settings::general::language::title(), "Language");
    assert_eq!(
        tr::settings::general::language::description(),
        "Choose the language Cap is shown in."
    );
    assert_eq!(tr::settings::general::language::label(), "App language");
    assert_eq!(
        tr::settings::general::language::system_default("Deutsch"),
        "System default (Deutsch)"
    );
    assert_eq!(
        KEYS.iter()
            .filter(|key| key.starts_with(NEW_IN_THE_LANGUAGE_PICKER))
            .count(),
        4
    );
}

#[test]
fn the_picker_shows_in_debug_builds() {
    if cfg!(debug_assertions) {
        assert!(picker_enabled());
    }
}

#[test]
fn system_tags_resolve_to_catalogs() {
    for (tag, expected) in [
        ("en-US", Some(Locale::En)),
        ("en_GB.UTF-8", Some(Locale::En)),
        ("fr-CA", Some(Locale::Fr)),
        ("de_DE@euro", Some(Locale::De)),
        ("es-419", Some(Locale::Es)),
        ("hi-IN", Some(Locale::Hi)),
        ("ja-JP", Some(Locale::Ja)),
        ("JA", Some(Locale::Ja)),
        ("zh", Some(Locale::ZhCn)),
        ("zh-CN", Some(Locale::ZhCn)),
        ("zh-SG", Some(Locale::ZhCn)),
        ("zh-Hans", Some(Locale::ZhCn)),
        ("zh-Hans-HK", Some(Locale::ZhCn)),
        ("zh_CN.UTF-8", Some(Locale::ZhCn)),
        ("zh-Hant", None),
        ("zh-Hant-CN", None),
        ("zh-TW", None),
        ("zh-HK", None),
        ("pt-BR", None),
        ("C", None),
        ("", None),
    ] {
        assert_eq!(match_tag(tag), expected, "{tag:?}");
    }
}

#[test]
fn traditional_chinese_falls_through_to_the_next_language() {
    let tags = |tags: &[&str]| tags.iter().map(|tag| tag.to_string()).collect::<Vec<_>>();
    assert_eq!(first_supported(tags(&["zh-Hant-TW", "ja-JP"])), Locale::Ja);
    assert_eq!(first_supported(tags(&["zh-Hant-TW"])), Locale::En);
    assert_eq!(first_supported(tags(&["pt-BR", "de-AT", "fr"])), Locale::De);
    assert_eq!(first_supported(Vec::new()), Locale::En);
}

#[test]
fn system_language_waits_for_the_picker() {
    assert_eq!(
        resolve_preference(Preference::System, false, || Locale::Ja),
        Locale::En
    );
    assert_eq!(
        resolve_preference(Preference::System, true, || Locale::Ja),
        Locale::Ja
    );
    assert_eq!(
        resolve_preference(Preference::Fixed(Locale::De), false, || Locale::Ja),
        Locale::De
    );
    assert_eq!(
        resolve_preference(Preference::Fixed(Locale::De), true, || Locale::Ja),
        Locale::De
    );
}

#[test]
fn stored_preferences_round_trip_and_unknown_values_follow_the_system() {
    assert_eq!(Preference::from_setting(None), Preference::System);
    assert_eq!(Preference::from_setting(Some("system")), Preference::System);
    assert_eq!(Preference::from_setting(Some("pt-BR")), Preference::System);
    assert_eq!(Preference::System.setting(), "system");
    for locale in Locale::ALL {
        let preference = Preference::Fixed(locale);
        assert_eq!(
            Preference::from_setting(Some(preference.setting())),
            preference
        );
    }
    let options: Vec<Preference> = Preference::options().collect();
    assert_eq!(options.len(), Locale::ALL.len() + 1);
    assert_eq!(options[0], Preference::System);
    assert_eq!(options[1], Preference::Fixed(Locale::En));
}

#[test]
fn picker_lists_endonyms_and_pseudo_only_in_debug_builds() {
    let endonyms: Vec<&str> = Locale::ALL.iter().map(|locale| locale.endonym()).collect();
    let mut expected = vec![
        "English",
        "简体中文",
        "日本語",
        "Français",
        "Español",
        "Deutsch",
        "हिन्दी",
    ];
    if cfg!(debug_assertions) {
        expected.push("Pseudo");
    }
    assert_eq!(endonyms, expected);
    assert_eq!(
        Locale::from_code("pseudo").is_some(),
        cfg!(debug_assertions)
    );
}

#[test]
fn only_cjk_and_devanagari_catalogs_change_the_font_cascade() {
    let first = |locale| {
        crate::theme::locale_font_fallbacks(locale)
            .map(|fallbacks| fallbacks.fallback_list().to_vec())
    };
    for locale in [Locale::En, Locale::Fr, Locale::Es, Locale::De] {
        assert_eq!(first(locale), None, "{locale:?}");
    }
    assert_eq!(
        first(Locale::Ja).unwrap(),
        ["Hiragino Sans", "Yu Gothic UI", "Noto Sans CJK JP"]
    );
    assert_eq!(
        first(Locale::ZhCn).unwrap(),
        ["PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC"]
    );
    assert_eq!(
        first(Locale::Hi).unwrap(),
        ["Kohinoor Devanagari", "Nirmala UI", "Noto Sans Devanagari"]
    );
}

/// Geist has no CJK or Devanagari glyphs, so those clusters are sized the way
/// the system faces set them: ideographs and kana are one em, Devanagari
/// letters a little over half, vowel signs a third or nothing.
fn missing_glyph_width(cluster: &str, size: f32) -> f32 {
    cluster
        .chars()
        .map(|c| match c {
            '\u{0900}'..='\u{0902}'
            | '\u{093A}'
            | '\u{093C}'
            | '\u{0941}'..='\u{0948}'
            | '\u{094D}'
            | '\u{0951}'..='\u{0957}'
            | '\u{0962}'..='\u{0963}' => 0.,
            '\u{0903}'
            | '\u{093B}'
            | '\u{093E}'..='\u{0940}'
            | '\u{0949}'..='\u{094C}'
            | '\u{094E}'..='\u{094F}' => 0.34,
            '\u{0900}'..='\u{097F}' => 0.62,
            _ => 1.,
        })
        .sum::<f32>()
        * size
}

/// Every string with a `max_px` budget, in every catalog, measured with the
/// bundled Geist Medium (the widest weight these labels use). A translation
/// over 92% of the budget fails (the system UI font differs from Geist by a
/// few percent), unless English is already wider, which then is the limit.
#[test]
fn translations_fit_their_width_budgets() {
    use cosmic_text::{
        Attrs, Buffer, Family, FontSystem, Metrics, Shaping, Weight, fontdb::Database,
    };

    let fonts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/fonts");
    let mut database = Database::new();
    for name in ["Geist.ttf", "Geist-Medium.ttf"] {
        database.load_font_data(std::fs::read(fonts.join(name)).unwrap());
    }
    let mut system = FontSystem::new_with_locale_and_db("en-US".into(), database);
    let attrs = Attrs::new()
        .family(Family::Name("Geist"))
        .weight(Weight::MEDIUM);

    let mut measure = |text: &str, size: f32| {
        let mut buffer = Buffer::new(&mut system, Metrics::new(size, size * 1.25));
        buffer.set_size(&mut system, None, None);
        buffer.set_text(&mut system, text, &attrs, Shaping::Advanced);
        buffer.shape_until_scroll(&mut system, false);
        buffer
            .layout_runs()
            .map(|run| {
                let mut width = 0.;
                let mut missing_cluster = None;
                for glyph in run.glyphs {
                    if glyph.glyph_id != 0 {
                        width += glyph.w;
                    } else if missing_cluster != Some((glyph.start, glyph.end)) {
                        // A shaped syllable can be several .notdef glyphs
                        // that all point at the same cluster.
                        missing_cluster = Some((glyph.start, glyph.end));
                        width += missing_glyph_width(&run.text[glyph.start..glyph.end], size);
                    }
                }
                width
            })
            .fold(0., f32::max)
    };

    let mut measured = 0;
    let mut failures = Vec::new();
    for fit in &FITS {
        // English is what ships today; where it already runs past 92% the
        // translations may not be any wider than it.
        let limit = (fit.max_px * 0.92).max(measure(fit.text[0], fit.size));
        for (locale, text) in Locale::ALL.iter().zip(fit.text).skip(1) {
            if locale.code() == "pseudo" {
                continue;
            }
            let width = measure(text, fit.size);
            measured += 1;
            if width > limit {
                failures.push(format!(
                    "{} `{}` {text:?}: {width:.1}px, limit {limit:.1}px of {}px",
                    locale.code(),
                    fit.key,
                    fit.max_px
                ));
            }
        }
    }
    assert!(measured > 0);
    assert!(
        failures.is_empty(),
        "over 92% of the width budget:\n{}",
        failures.join("\n")
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

    assert_eq!(
        tr::menu::update::badge_progress("0.4.0", 42),
        "v0.4.0 · 42%"
    );
    assert_eq!(tr::menu::update::badge_version("0.4.0"), "v0.4.0");
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
