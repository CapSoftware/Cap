use super::*;

pub(super) const NEW_COMMON: &[&str] = &[
    "common.back",
    "common.choose_allow_prompt",
    "common.close",
    "common.copied",
    "common.dismiss",
    "common.go_back",
    "common.loading",
    "common.no",
    "common.search",
    "common.yes",
];

pub(super) fn is_main_surface_key(key: &str) -> bool {
    ["main.", "controls.", "camera.", "onboarding."]
        .iter()
        .any(|prefix| key.starts_with(prefix))
        || NEW_COMMON.contains(&key)
}

const FORMATTED: &[&str] = &[
    "main.device.format.available",
    "main.device.format.apply_failed",
    "main.device.format.channels",
    "main.device.format.current",
    "main.library.clips",
    "main.recording.starts_in",
    "main.recovery.duration_minutes",
    "main.recovery.duration_minutes_seconds",
    "main.recovery.duration_seconds",
    "main.recovery.segments",
    "main.recovery.segments_with_duration",
    "main.storage.blocked",
    "main.storage.can_start",
    "main.storage.check_failed",
];

#[test]
fn main_surfaces_match_the_literals_they_replaced() {
    let pairs: &[(&str, &str)] = &[
        (tr::main::device::fallback_camera(), "Camera"),
        (tr::main::mode::name::instant(), "Instant"),
        (tr::main::mode::name::studio(), "Studio"),
        (tr::main::mode::name::screenshot(), "Screenshot"),
        (
            tr::main::mode::hover::instant_description(),
            "No rendering required — uploads on the fly so you can share the link the moment you stop.",
        ),
        (
            tr::main::mode::hover::studio_description(),
            "Saves to your computer and opens the editor when you stop. Choose recording quality in settings.",
        ),
        (
            tr::main::mode::hover::screenshot_description(),
            "Capture and annotate stills.",
        ),
        (
            tr::main::mode::hover::quality_settings(),
            "Quality settings",
        ),
        (tr::main::mode::info::title(), "Recording Modes"),
        (tr::main::mode::info::current(), "Current"),
        (tr::main::mode::info_tooltip(), "Recording mode info"),
        (tr::camera::blur::light(), "Light"),
        (tr::camera::blur::heavy(), "Heavy"),
        (tr::camera::blur::cutout(), "Cutout"),
        (tr::main::target::display(), "Display"),
        (tr::main::target::window(), "Window"),
        (tr::main::target::area(), "Area"),
        (tr::main::target::camera_only(), "Camera Only"),
        (tr::main::target::choose_display(), "Choose a display"),
        (tr::main::target::choose_window(), "Choose a window"),
        (tr::main::target::no_displays(), "No displays found"),
        (
            tr::main::target::no_matching_displays(),
            "No matching displays",
        ),
        (tr::main::target::no_windows(), "No windows found"),
        (
            tr::main::target::no_matching_windows(),
            "No matching windows",
        ),
        (tr::main::target::heading(), "Choose a capture source"),
        (tr::main::device::camera(), "Camera"),
        (tr::main::device::microphone(), "Microphone"),
        (tr::main::device::no_camera(), "No Camera"),
        (tr::main::device::no_microphone(), "No Microphone"),
        (tr::main::device::no_cameras(), "No cameras found"),
        (
            tr::main::device::no_matching_cameras(),
            "No matching cameras",
        ),
        (tr::main::device::no_microphones(), "No microphones found"),
        (
            tr::main::device::no_matching_microphones(),
            "No matching microphones",
        ),
        (
            tr::main::device::heading(),
            "Choose your camera and microphone",
        ),
        (tr::main::device::system_audio_on(), "Record System Audio"),
        (tr::main::device::system_audio_off(), "No System Audio"),
        (tr::main::device::pill::on(), "On"),
        (tr::main::device::pill::off(), "Off"),
        (tr::main::device::pill::not_connected(), "Not connected"),
        (tr::main::device::pill::asking(), "Asking…"),
        (
            tr::main::device::pill::allow_in_settings(),
            "Allow in Settings",
        ),
        (tr::main::device::pill::allow(), "Allow"),
        (
            tr::common::choose_allow_prompt(),
            "Choose Allow in the macOS prompt.",
        ),
        (
            tr::main::device::access::open_system_settings(),
            "Open System Settings",
        ),
        (tr::main::device::format::default(), "Default"),
        (tr::main::device::format::mono(), "Mono"),
        (tr::main::device::format::stereo(), "Stereo"),
        (
            tr::main::device::format::save_failed(),
            "Could not save the device format preference. Try again.",
        ),
        (
            tr::main::device::format::camera_changed(),
            "Camera changed or disconnected. Reopen its format settings.",
        ),
        (tr::main::device::format::preferred(), "Preferred format"),
        (tr::main::device::format::loading(), "Loading formats..."),
        (tr::main::device::format::applying(), "Applying format..."),
        (tr::main::library::import_recordings(), "Import"),
        (tr::main::library::import_screenshots(), "Import image"),
        (tr::main::library::no_recordings(), "No recordings yet"),
        (tr::main::library::no_screenshots(), "No screenshots yet"),
        (
            tr::main::library::view_all_recordings(),
            "View All Recordings",
        ),
        (
            tr::main::library::view_all_screenshots(),
            "View All Screenshots",
        ),
        (
            tr::main::library::no_matching_recordings(),
            "No matching recordings",
        ),
        (
            tr::main::library::no_matching_screenshots(),
            "No matching screenshots",
        ),
        (tr::main::library::importing(), "Importing"),
        (
            tr::main::library::recordings_description(),
            "Your screen recordings will appear here. Start recording to get started!",
        ),
        (
            tr::main::library::screenshots_description(),
            "Your screenshots will appear here. Take a screenshot to get started!",
        ),
        (
            tr::main::library::copy_screenshot_failed(),
            "Could not copy screenshot",
        ),
        (
            tr::main::delete_recording_confirm(),
            "Are you sure you want to delete this recording?",
        ),
        (
            tr::main::delete_screenshot_confirm(),
            "Are you sure you want to delete this screenshot?",
        ),
        (tr::common::yes(), "Yes"),
        (tr::common::no(), "No"),
        (tr::main::header::help(), "Help & Tour"),
        (tr::main::header::settings(), "Settings"),
        (tr::main::header::screenshots(), "Screenshots"),
        (tr::main::header::recordings(), "Recordings"),
        (tr::main::header::teleprompter(), "Teleprompter"),
        (tr::main::header::changelog(), "Changelog"),
        (tr::main::plan::personal(), "Personal"),
        (tr::main::plan::commercial(), "Commercial"),
        (tr::main::clip::record_new(), "Record a new clip"),
        (
            tr::main::clip::add_to_project(),
            "Add to your current project",
        ),
        (tr::main::recording::starting(), "Starting..."),
        (
            tr::main::recording::paused_notice(),
            "Recording paused. Cap will hide before resuming.",
        ),
        (tr::main::recording::resume(), "Resume"),
        (tr::main::recording::cancel(), "Cancel Recording"),
        (tr::main::recording::stopping(), "Stopping..."),
        (tr::main::recording::stop(), "Stop Recording"),
        (tr::common::back(), "Back"),
        (tr::common::search(), "Search"),
        (tr::common::loading(), "Loading..."),
        (tr::common::close(), "Close"),
        (tr::main::storage::title(), "Low storage"),
        (tr::main::storage::record_anyway(), "Record anyway"),
        (tr::common::go_back(), "Go back"),
        (
            tr::main::error::camera_only_needs_camera(),
            "Camera-only recording requires a selected camera.",
        ),
        (
            tr::main::error::devices_not_ready(),
            "Recording devices are not ready. Open the recorder and try again.",
        ),
        (
            tr::main::sign_in::timed_out(),
            "Sign in timed out. Try again.",
        ),
        (tr::main::mic_warning::title(), "No microphone detected"),
        (
            tr::main::mic_warning::body(),
            "This recording will not include your voice. Select a microphone, or continue without one.",
        ),
        (tr::main::mic_warning::dont_show_again(), "Don't show again"),
        (
            tr::main::mic_warning::record_without(),
            "Record without microphone",
        ),
        (
            tr::main::mic_warning::save_failed(),
            "Could not save your preference. Try again or leave the box unchecked.",
        ),
        (
            tr::main::sign_in::pending_message(),
            "Finish signing in to Cap in your browser. Cap comes back here and opens the recorder when you're done.",
        ),
        (
            tr::main::sign_in::message(),
            "Instant Mode uploads while you record, so your shareable link is ready the moment you stop.",
        ),
        (
            tr::main::sign_in::open_browser_again(),
            "Open browser again",
        ),
        (tr::main::sign_in::sign_in(), "Sign In"),
        (tr::main::sign_in::use_studio(), "Use Studio"),
        (tr::main::sign_in::not_now(), "Not now"),
        (tr::main::sign_in::waiting(), "Waiting for your browser"),
        (tr::main::sign_in::title(), "Sign in to use Instant Mode"),
        (tr::main::clean_capture::title(), "Keep your capture clean"),
        (tr::main::recovery::title(), "Incomplete Recording"),
        (tr::main::recovery::recover(), "Recover"),
        (tr::main::recovery::discard(), "Discard"),
        (tr::main::error::copy(), "Copy error"),
        (tr::common::copied(), "Copied"),
        (tr::common::dismiss(), "Dismiss"),
        (tr::main::error::title(), "Something went wrong"),
        (
            tr::main::device::access::turn_on_in_settings(),
            "Turn on in Settings",
        ),
        (tr::main::device::access::allow_access(), "Allow access"),
        (tr::controls::stop::starting(), "Starting"),
        (tr::controls::stop::saving(), "Saving…"),
        (tr::controls::stop::resuming(), "Resuming…"),
        (tr::controls::stop::pausing(), "Pausing…"),
        (tr::controls::stop::paused(), "Paused"),
        (tr::controls::stop::error(), "Error"),
        (tr::controls::confirm::restart_title(), "Confirm Restart"),
        (
            tr::controls::confirm::restart_message(),
            "Are you sure you want to restart the recording? The current recording will be discarded.",
        ),
        (tr::controls::confirm::restart(), "Restart"),
        (tr::controls::confirm::delete_title(), "Confirm Delete"),
        (
            tr::controls::confirm::delete_message(),
            "Are you sure you want to delete the recording?",
        ),
        (tr::controls::confirm::delete(), "Delete"),
        (
            tr::controls::pause::unconfirmed(),
            "Capture state is unconfirmed. Use Stop.",
        ),
        (tr::controls::pause::resuming(), "Resuming recording…"),
        (tr::controls::pause::pausing(), "Pausing recording…"),
        (tr::controls::pause::resume(), "Resume recording"),
        (tr::controls::pause::pause(), "Pause recording"),
        (
            tr::controls::low_storage(),
            "Low storage. Cap will stop soon to save your recording.",
        ),
        (
            tr::controls::disk_full_resume(),
            "Not enough disk space to resume. Free up space and try again, or press Stop to save.",
        ),
        (tr::camera::issue::access_title(), "Camera access needed"),
        (
            tr::camera::issue::access_message(),
            "Click to allow Cap to use your camera in System Settings.",
        ),
        (tr::camera::issue::unavailable_title(), "Camera unavailable"),
        (
            tr::camera::issue::not_found(),
            "This camera is no longer available. Check that it is connected and allowed by system permissions.",
        ),
        (
            tr::camera::issue::timeout(),
            "No frames were received from this camera. It may be closed, disconnected, covered, or in use by another app.",
        ),
        (
            tr::camera::issue::start_failed(),
            "The system could not start this camera. It may be unavailable or in use by another app.",
        ),
        (
            tr::camera::issue::invalid_format(),
            "This camera did not report a usable capture format.",
        ),
        (
            tr::camera::issue::generic(),
            "The selected camera could not be started. Choose another camera or reconnect this one.",
        ),
        (tr::camera::effects::mirror_title(), "Mirror unavailable"),
        (
            tr::camera::effects::mirror_message(),
            "Your camera preview is not mirrored.",
        ),
        (
            tr::camera::effects::blur_title(),
            "Background blur unavailable",
        ),
        (
            tr::camera::effects::blur_message(),
            "Your camera is unblurred.",
        ),
        (
            tr::camera::effects::both_title(),
            "Camera effects unavailable",
        ),
        (
            tr::camera::effects::both_message(),
            "Your camera is unblurred and not mirrored.",
        ),
        (tr::camera::waiting_title(), "Waiting for camera access"),
        (tr::onboarding::modes::instant::title(), "Instant Mode"),
        (
            tr::onboarding::modes::instant::tagline(),
            "Record & share in seconds",
        ),
        (
            tr::onboarding::modes::instant::description(),
            "Your recording uploads as you capture. Stop recording and instantly get a shareable link — no waiting.",
        ),
        (
            tr::onboarding::modes::instant::feature_1(),
            "Instant shareable link",
        ),
        (
            tr::onboarding::modes::instant::feature_2(),
            "Background uploading",
        ),
        (
            tr::onboarding::modes::instant::feature_3(),
            "AI transcription & summary",
        ),
        (
            tr::onboarding::modes::instant::feature_4(),
            "Browser-based playback",
        ),
        (tr::onboarding::modes::studio::title(), "Studio Mode"),
        (
            tr::onboarding::modes::studio::tagline(),
            "Professional editing tools",
        ),
        (
            tr::onboarding::modes::studio::description(),
            "Record in full quality locally, then use the built-in editor to add backgrounds, padding, cursor effects, and more.",
        ),
        (
            tr::onboarding::modes::studio::feature_1(),
            "Full quality local recording",
        ),
        (
            tr::onboarding::modes::studio::feature_2(),
            "Built-in editor & effects",
        ),
        (
            tr::onboarding::modes::studio::feature_3(),
            "Custom backgrounds & padding",
        ),
        (
            tr::onboarding::modes::studio::feature_4(),
            "Export or share when ready",
        ),
        (
            tr::onboarding::modes::screenshot::title(),
            "Screenshot Mode",
        ),
        (
            tr::onboarding::modes::screenshot::tagline(),
            "Capture & beautify instantly",
        ),
        (
            tr::onboarding::modes::screenshot::description(),
            "Take screenshots with a single hotkey, add annotations and beautiful backgrounds, then share or copy instantly.",
        ),
        (
            tr::onboarding::modes::screenshot::feature_1(),
            "Instant hotkey capture",
        ),
        (
            tr::onboarding::modes::screenshot::feature_2(),
            "Annotation & drawing tools",
        ),
        (
            tr::onboarding::modes::screenshot::feature_3(),
            "Beautiful backgrounds",
        ),
        (
            tr::onboarding::modes::screenshot::feature_4(),
            "Copy, save, or share",
        ),
        (tr::onboarding::faq::free::question(), "Is Cap free to use?"),
        (
            tr::onboarding::faq::free::answer(),
            "Cap is free for personal use. For teams and commercial use, check out our pricing plans.",
        ),
        (
            tr::onboarding::faq::instant_vs_studio::question(),
            "What's the difference between Instant and Studio?",
        ),
        (
            tr::onboarding::faq::instant_vs_studio::answer(),
            "Instant mode uploads as you record — stop recording and you'll have a shareable link immediately. Studio mode records locally in full quality, letting you edit with backgrounds, effects, and more before sharing.",
        ),
        (
            tr::onboarding::faq::storage::question(),
            "Where are my recordings stored?",
        ),
        (
            tr::onboarding::faq::storage::answer(),
            "All recordings are stored locally on your computer. In Instant mode, they're also uploaded to Cap's cloud for easy sharing. You can manage storage in Settings.",
        ),
        (
            tr::onboarding::faq::shortcuts::question(),
            "Can I change my shortcuts later?",
        ),
        (
            tr::onboarding::faq::shortcuts::answer(),
            "Head to Settings → Shortcuts at any time to customize all your keyboard shortcuts.",
        ),
        (
            tr::onboarding::faq::sharing::question(),
            "How does sharing work?",
        ),
        (
            tr::onboarding::faq::sharing::answer(),
            "In Instant mode, you get a shareable link automatically when you stop recording. In Studio mode, export your edited video and share via Cap's cloud or save locally.",
        ),
        (
            tr::onboarding::error::save_progress(),
            "Could not save onboarding progress. Please try again.",
        ),
        (
            tr::onboarding::error::save_sound(),
            "Could not save the sound preference.",
        ),
        (tr::onboarding::welcome::get_started(), "Get Started"),
        (
            tr::onboarding::welcome::click_or_press(),
            "Click here, or press",
        ),
        (tr::onboarding::welcome::space_key(), "Space"),
        (
            tr::onboarding::welcome::tagline(),
            "The open source screen sharing app for everyone.",
        ),
        (tr::onboarding::overview::title(), "One app, every workflow"),
        (
            tr::onboarding::overview::subtitle(),
            "Whether you need speed, studio quality, or a quick screenshot — Cap has a mode for it.",
        ),
        (tr::onboarding::customize::title(), "Make Cap yours"),
        (
            tr::onboarding::customize::subtitle(),
            "Customize everything from keyboard shortcuts to storage. Cap adapts to your workflow.",
        ),
        (tr::onboarding::toggle::title(), "Switch modes anytime"),
        (
            tr::onboarding::toggle::subtitle(),
            "Toggle between modes with a single click from the main Cap window.",
        ),
        (tr::onboarding::faq::title(), "Frequently Asked Questions"),
        (
            tr::onboarding::faq::subtitle(),
            "Everything you need to know to get started.",
        ),
        (
            tr::onboarding::customize::shortcuts::title(),
            "Keyboard Shortcuts",
        ),
        (
            tr::onboarding::customize::shortcuts::description(),
            "Global hotkeys for recording, screenshots, and switching modes",
        ),
        (tr::onboarding::customize::s3::title(), "Custom S3 Storage"),
        (
            tr::onboarding::customize::s3::description(),
            "Connect your own S3-compatible bucket for full control over your recordings",
        ),
        (tr::onboarding::customize::domain::title(), "Custom Domain"),
        (
            tr::onboarding::customize::domain::description(),
            "Use your own domain for shareable links instead of cap.so",
        ),
        (
            tr::onboarding::customize::preferences::title(),
            "Recording Preferences",
        ),
        (
            tr::onboarding::customize::preferences::description(),
            "FPS, quality, countdown timer, cursor effects, and more",
        ),
        (
            tr::onboarding::customize::footer(),
            "Change any of these at any time in Settings",
        ),
        (tr::onboarding::faq::pricing(), "View pricing plans"),
        (tr::onboarding::faq::pricing_link(), "View pricing plans ↗"),
        (tr::onboarding::nav::relaunch(), "Relaunch Cap"),
        (tr::onboarding::nav::continue_to_cap(), "Continue to Cap"),
        (tr::onboarding::nav::start(), "Start Using Cap"),
        (tr::onboarding::nav::next(), "Continue"),
        (tr::onboarding::nav::back(), "←  Back"),
        (
            tr::onboarding::nav::permissions_needed(),
            "Allow the required permissions to continue",
        ),
        (
            tr::onboarding::nav::keyboard_hint(),
            "Press Enter ↵ or use ← → arrow keys",
        ),
        (tr::onboarding::nav::skip(), "Skip the tour"),
        (tr::onboarding::demo::start_recording(), "Start Recording"),
        (tr::onboarding::demo::stopped(), "Stopped"),
        (tr::onboarding::demo::link_ready(), "Link ready to share!"),
        (tr::onboarding::demo::copied(), "Copied!"),
        (tr::onboarding::demo::copy(), "Copy"),
        (tr::onboarding::demo::editor(), "Cap Editor"),
        (tr::onboarding::demo::export(), "Export"),
        (tr::onboarding::demo::style(), "STYLE"),
        (tr::onboarding::demo::background(), "BACKGROUND"),
        (tr::onboarding::demo::export_complete(), "Export complete!"),
        (tr::onboarding::demo::exporting(), "Exporting..."),
        (tr::onboarding::demo::save(), "Save"),
        (
            tr::onboarding::demo::copied_to_clipboard(),
            "Copied to clipboard",
        ),
        (tr::onboarding::demo::steps::record(), "Record"),
        (tr::onboarding::demo::steps::stop(), "Stop"),
        (tr::onboarding::demo::steps::share_link(), "Share link"),
        (tr::onboarding::demo::steps::edit(), "Edit"),
        (tr::onboarding::demo::steps::select_area(), "Select area"),
        (tr::onboarding::demo::steps::beautify(), "Beautify"),
    ];
    for (translated, literal) in pairs {
        assert_eq!(translated, literal);
    }
    use crate::main_window::Mode;
    let assembled: &[(&str, String)] = &[
        (
            tr::main::mode::hover::instant(),
            format!("{} mode", Mode::Instant.panel_title()),
        ),
        (
            tr::main::mode::hover::studio(),
            format!("{} mode", Mode::Studio.panel_title()),
        ),
        (
            tr::main::mode::hover::screenshot(),
            format!("{} mode", Mode::Screenshot.panel_title()),
        ),
        (
            tr::main::mode::header::instant(),
            format!("{} Mode", Mode::Instant.panel_title()),
        ),
        (
            tr::main::mode::header::studio(),
            format!("{} Mode", Mode::Studio.panel_title()),
        ),
        (
            tr::main::mode::header::screenshot(),
            format!("{} Mode", Mode::Screenshot.panel_title()),
        ),
    ];
    for (translated, literal) in assembled {
        assert_eq!(*translated, literal.as_str());
    }
    let mut access = Vec::new();
    for noun in ["camera", "microphone"] {
        access.push(format!(
            "Cap can't use your {noun}. Turn it on in System Settings."
        ));
        access.push(format!("Cap needs your OK to use your {noun}."));
    }
    assert_eq!(
        [
            tr::main::device::access::camera_denied(),
            tr::main::device::access::camera_needed(),
            tr::main::device::access::microphone_denied(),
            tr::main::device::access::microphone_needed(),
        ],
        [
            access[0].as_str(),
            access[1].as_str(),
            access[2].as_str(),
            access[3].as_str(),
        ]
    );
    let plain_keys = KEYS.iter().filter(|key| is_main_surface_key(key)).count() - FORMATTED.len();
    assert_eq!(
        pairs.len() + assembled.len() + access.len(),
        plain_keys,
        "every plain key has a literal above"
    );
    for key in FORMATTED {
        assert!(KEYS.contains(key), "{key}");
    }
}

#[test]
fn main_surface_messages_format_like_the_code_they_replaced() {
    for count in [0, 3, 4, 8] {
        assert_eq!(
            tr::main::device::format::channels(count),
            format!("{count} channels")
        );
    }
    let format = "1920×1080 @ 30fps".to_string();
    assert_eq!(
        tr::main::device::format::available(&format),
        format!("Available: {}", format)
    );
    let description = "48kHz Stereo".to_string();
    assert_eq!(
        Some(description.clone()).map(tr::main::device::format::available),
        Some(description).map(|description| format!("Available: {description}"))
    );
    let error = "input disconnected".to_string();
    assert_eq!(
        tr::main::device::format::apply_failed(&error),
        format!("Could not apply device format: {error}")
    );
    assert_eq!(
        tr::main::device::format::current("Default"),
        format!("Current: {}", "Default")
    );
    for clip_count in [2_u32, 3, 12] {
        assert_eq!(
            tr::main::library::clips(clip_count as usize),
            format!("{clip_count} clips")
        );
    }
    for remaining in [1_u32, 3, 10] {
        assert_eq!(
            tr::main::recording::starts_in(remaining),
            format!("Recording starts in {remaining}")
        );
    }
    for bytes in [0_u64, 549_755_813, 3_373_259_571, 1_073_741_824_000] {
        let available = bytes as f64 / 1_073_741_824.0;
        let shown = format!("{:.2}", available);
        assert_eq!(
            tr::main::storage::can_start(&shown),
            format!(
                "Only {available:.2} GB is available on your recording drive. Cap will stop automatically if storage gets too low, preserving your recording."
            )
        );
        assert_eq!(
            tr::main::storage::blocked(&shown),
            format!(
                "Only {available:.2} GB is available on your recording drive. Free up space so at least 512 MB is available before recording."
            )
        );
    }
    let error = "permission denied".to_string();
    assert_eq!(
        tr::main::storage::check_failed(&error),
        format!("Could not check recording storage: {error}")
    );
}
