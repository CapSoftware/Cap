use super::*;

/// Every key the settings surfaces own. The shortcut effects are pinned
/// separately, against every combination of settings that builds them, in
/// `settings_pages`'s `shortcut_effects_match_the_sentences_they_replaced`.
const PREFIXES: &[&str] = &[
    "settings.automations.",
    "settings.changelog.",
    "settings.cli.",
    "settings.experimental.",
    "settings.feedback.",
    "settings.integrations.",
    "settings.license.",
    "settings.options.",
    "settings.prompt.",
    "settings.quality.",
    "settings.recordings.",
    "settings.screenshots.",
    "settings.shortcuts.",
    "settings.sidebar.",
    "settings.sign_in_required.",
    "settings.transcription.",
];

const EFFECT_PREFIXES: &[&str] = &["settings.shortcuts.effect.", "settings.shortcuts.sentence."];

pub(super) fn is_settings_surface_key(key: &str) -> bool {
    PREFIXES.iter().any(|prefix| key.starts_with(prefix))
}

const FORMATTED: &[&str] = &[
    "settings.sidebar.downloading",
    "settings.sidebar.downloading_progress",
    "settings.sidebar.installing",
    "settings.sidebar.restart_to_update",
    "settings.shortcuts.saved",
    "settings.shortcuts.saved_moved",
    "settings.cli.load_failed",
    "settings.cli.installs_command",
    "settings.cli.path_missing",
    "settings.transcription.count",
    "settings.experimental.switch.open_failed",
    "settings.experimental.switch.check_failed",
    "settings.feedback.diagnostic.confirm_body",
    "settings.changelog.version",
    "settings.integrations.managed_by",
    "settings.integrations.s3.guide_intro",
    "settings.integrations.gdrive.working_for",
    "settings.integrations.gdrive.used_of",
    "settings.integrations.gdrive.used",
    "settings.integrations.gdrive.cached",
    "settings.integrations.gdrive.updated",
    "settings.automations.summary_empty",
    "settings.automations.auto_name_empty",
];

#[test]
fn settings_surfaces_match_the_literals_they_replaced() {
    let pairs: &[(&str, &str)] = &[
        (tr::settings::prompt::ok(), "Ok"),
        (tr::settings::sidebar::account(), "Account"),
        (
            tr::settings::sidebar::click_to_sign_in(),
            "Click to sign in",
        ),
        (tr::settings::sidebar::signed_in(), "Signed in"),
        (tr::settings::sidebar::sign_in(), "Sign In"),
        (tr::settings::sidebar::sign_out(), "Sign Out"),
        (tr::settings::sidebar::cancel_sign_in(), "Cancel Sign In"),
        (
            tr::settings::sidebar::check_for_updates(),
            "Check for updates",
        ),
        (
            tr::settings::sidebar::checking_for_updates(),
            "Checking for updates…",
        ),
        (
            tr::settings::sidebar::previous_versions(),
            "View previous versions",
        ),
        (tr::settings::recordings::title(), "Recordings"),
        (
            tr::settings::recordings::description(),
            "Manage your recordings and perform actions.",
        ),
        (tr::settings::recordings::import(), "Import"),
        (
            tr::settings::recordings::empty_library(),
            "No recordings found",
        ),
        (tr::settings::recordings::show_all(), "Show all"),
        (tr::settings::recordings::empty::all(), "No recordings"),
        (
            tr::settings::recordings::empty::all_matching(),
            "No matching recordings",
        ),
        (
            tr::settings::recordings::empty::instant(),
            "No instant recordings",
        ),
        (
            tr::settings::recordings::empty::instant_matching(),
            "No matching instant recordings",
        ),
        (
            tr::settings::recordings::empty::studio(),
            "No studio recordings",
        ),
        (tr::settings::recordings::load_more(), "Load more"),
        (
            tr::settings::recordings::in_progress(),
            "Recording in progress",
        ),
        (tr::settings::recordings::failed(), "Recording failed"),
        (tr::settings::recordings::open_link(), "Open link"),
        (tr::settings::recordings::edit(), "Edit"),
        (tr::settings::recordings::retry_upload(), "Retry upload"),
        (
            tr::settings::recordings::open_bundle(),
            "Open recording bundle",
        ),
        (tr::settings::recordings::delete(), "Delete"),
        (
            tr::settings::recordings::corrupted_title(),
            "Recording is potentially corrupted",
        ),
        (
            tr::settings::recordings::corrupted_body(),
            "The recording failed so this file may have issues in the editor! If your having issues recovering the file please reach out to support!",
        ),
        (tr::settings::screenshots::title(), "Screenshots"),
        (
            tr::settings::screenshots::description(),
            "Manage your screenshots and perform actions.",
        ),
        (tr::settings::screenshots::import(), "Import image"),
        (
            tr::settings::screenshots::empty_library(),
            "No screenshots found",
        ),
        (tr::settings::screenshots::empty(), "No screenshots"),
        (
            tr::settings::screenshots::empty_matching(),
            "No matching screenshots",
        ),
        (tr::settings::screenshots::load_more(), "Load more"),
        (tr::settings::screenshots::copy(), "Copy to clipboard"),
        (tr::settings::screenshots::save_as(), "Save as"),
        (tr::settings::screenshots::open_folder(), "Open folder"),
        (tr::settings::screenshots::delete(), "Delete"),
        (
            tr::settings::quality::save_failed(),
            "Couldn't save your recording settings. Please try again.",
        ),
        (tr::settings::quality::studio::title(), "Studio recordings"),
        (
            tr::settings::quality::studio::description(),
            "Saved to your computer for editing. You choose the export size later, in the editor.",
        ),
        (tr::settings::quality::studio::recommended(), "Recommended"),
        (tr::settings::quality::studio::balanced(), "Balanced"),
        (
            tr::settings::quality::studio::balanced_description(),
            "Sharp detail at a sensible file size. Right for most recordings.",
        ),
        (
            tr::settings::quality::studio::compatibility(),
            "Smaller files",
        ),
        (
            tr::settings::quality::studio::compatibility_description(),
            "Saves disk space. Fine detail can soften, most of all on camera.",
        ),
        (tr::settings::quality::studio::ultra(), "Maximum detail"),
        (
            tr::settings::quality::studio::ultra_description(),
            "Keeps the most detail for heavy editing. Uses the most disk space.",
        ),
        (
            tr::settings::quality::instant::title(),
            "Instant recordings",
        ),
        (
            tr::settings::quality::instant::description(),
            "Uploaded while you record, so the link is ready the moment you stop. For the best quality, use Studio mode: it records at the highest quality your screen allows, and you can export up to 4K.",
        ),
        (
            tr::settings::quality::instant::max_resolution(),
            "Maximum resolution",
        ),
        (
            tr::settings::quality::instant::free_plan(),
            "720p on the free plan. Cap Pro records up to 4K.",
        ),
        (
            tr::settings::quality::instant::res_720p(),
            "Smallest uploads, so links are ready fastest.",
        ),
        (
            tr::settings::quality::instant::res_1080p(),
            "Sharp text at a practical upload size.",
        ),
        (
            tr::settings::quality::instant::res_1440p(),
            "Extra detail for large, high-resolution screens.",
        ),
        (
            tr::settings::quality::instant::res_4k(),
            "The most detail. Best on a fast connection.",
        ),
        (tr::settings::quality::sharing::title(), "Sharing"),
        (
            tr::settings::quality::sharing::auto_open(),
            "Open share links automatically",
        ),
        (
            tr::settings::quality::sharing::auto_open_description(),
            "Open the link in your browser when an upload finishes.",
        ),
        (
            tr::settings::options::studio_quality::compatibility(),
            "Compatibility",
        ),
        (
            tr::settings::options::studio_quality::balanced(),
            "Balanced",
        ),
        (tr::settings::options::studio_quality::ultra(), "Ultra"),
        (tr::settings::options::main_window_start::close(), "Close"),
        (
            tr::settings::options::main_window_start::minimise(),
            "Minimise",
        ),
        (
            tr::settings::options::window_capture::screen_region(),
            "Screen region",
        ),
        (
            tr::settings::options::window_capture::focused_window(),
            "Focused window",
        ),
        (
            tr::settings::options::post_studio::open_editor(),
            "Open editor",
        ),
        (tr::settings::options::post_studio::show_cap(), "Show Cap"),
        (
            tr::settings::options::post_studio::do_nothing(),
            "Do nothing",
        ),
        (
            tr::settings::options::post_screenshot::open_editor(),
            "Open editor",
        ),
        (
            tr::settings::options::post_screenshot::copy(),
            "Copy to clipboard",
        ),
        (
            tr::settings::options::post_screenshot::copy_and_open_editor(),
            "Copy and open editor",
        ),
        (
            tr::settings::options::post_screenshot::do_nothing(),
            "Do nothing",
        ),
        (
            tr::settings::options::post_deletion::do_nothing(),
            "Do nothing",
        ),
        (
            tr::settings::options::post_deletion::reopen(),
            "Reopen recording window",
        ),
        (tr::settings::options::preview_quality::quarter(), "Quarter"),
        (tr::settings::options::preview_quality::half(), "Half"),
        (tr::settings::options::preview_quality::full(), "Full"),
        (tr::settings::shortcuts::screenshots_title(), "Screenshots"),
        (
            tr::settings::shortcuts::screenshots_description(),
            "Shortcuts work from any app. Click one to change it.",
        ),
        (tr::settings::shortcuts::recording_title(), "Recording"),
        (
            tr::settings::shortcuts::recording_description(),
            "Start a recording without opening Cap first.",
        ),
        (
            tr::settings::shortcuts::while_recording_title(),
            "While recording",
        ),
        (
            tr::settings::shortcuts::after_screenshot::title(),
            "After a screenshot",
        ),
        (
            tr::settings::shortcuts::after_screenshot::hint(),
            "For every screenshot, from a shortcut or from Cap",
        ),
        (
            tr::settings::shortcuts::after_studio::title(),
            "After a Studio recording",
        ),
        (
            tr::settings::shortcuts::after_studio::hint(),
            "When you stop",
        ),
        (
            tr::settings::shortcuts::after_instant::title(),
            "After an Instant recording",
        ),
        (
            tr::settings::shortcuts::after_instant::hint(),
            "The share link is always copied",
        ),
        (
            tr::settings::shortcuts::outcome::screenshot_open_editor(),
            "Open editor",
        ),
        (
            tr::settings::shortcuts::outcome::screenshot_open_editor_hint(),
            "Annotate first",
        ),
        (tr::settings::shortcuts::outcome::screenshot_copy(), "Copy"),
        (
            tr::settings::shortcuts::outcome::screenshot_copy_hint(),
            "Paste anywhere",
        ),
        (
            tr::settings::shortcuts::outcome::screenshot_copy_and_edit(),
            "Copy and edit",
        ),
        (
            tr::settings::shortcuts::outcome::screenshot_copy_and_edit_hint(),
            "Both at once",
        ),
        (
            tr::settings::shortcuts::outcome::screenshot_do_nothing(),
            "Do nothing",
        ),
        (
            tr::settings::shortcuts::outcome::saved_to_library(),
            "Saved to library",
        ),
        (
            tr::settings::shortcuts::outcome::studio_open_editor(),
            "Open editor",
        ),
        (
            tr::settings::shortcuts::outcome::studio_open_editor_hint(),
            "Edit right away",
        ),
        (
            tr::settings::shortcuts::outcome::studio_show_cap(),
            "Show Cap",
        ),
        (
            tr::settings::shortcuts::outcome::studio_show_cap_hint(),
            "Back to the recorder",
        ),
        (
            tr::settings::shortcuts::outcome::studio_do_nothing(),
            "Do nothing",
        ),
        (
            tr::settings::shortcuts::outcome::instant_open_link(),
            "Open link",
        ),
        (
            tr::settings::shortcuts::outcome::instant_open_link_hint(),
            "In your browser",
        ),
        (
            tr::settings::shortcuts::outcome::instant_show_cap(),
            "Show Cap",
        ),
        (
            tr::settings::shortcuts::outcome::instant_show_cap_hint(),
            "Back to the recorder",
        ),
        (
            tr::settings::shortcuts::outcome::instant_copy_link(),
            "Copy link only",
        ),
        (
            tr::settings::shortcuts::outcome::instant_copy_link_hint(),
            "Nothing opens",
        ),
        (
            tr::settings::shortcuts::label::screenshot_area(),
            "Screenshot an area",
        ),
        (
            tr::settings::shortcuts::label::screenshot_window(),
            "Screenshot a window",
        ),
        (
            tr::settings::shortcuts::label::screenshot_display(),
            "Screenshot the display",
        ),
        (
            tr::settings::shortcuts::label::start_studio(),
            "Start Studio recording",
        ),
        (
            tr::settings::shortcuts::label::start_instant(),
            "Start Instant recording",
        ),
        (
            tr::settings::shortcuts::label::record_area(),
            "Record an area",
        ),
        (
            tr::settings::shortcuts::label::record_window(),
            "Record a window",
        ),
        (
            tr::settings::shortcuts::label::record_display(),
            "Record a display",
        ),
        (
            tr::settings::shortcuts::label::open_picker(),
            "Open recording picker",
        ),
        (
            tr::settings::shortcuts::label::cycle_mode(),
            "Cycle recording mode",
        ),
        (tr::settings::shortcuts::label::stop(), "Stop recording"),
        (tr::settings::shortcuts::label::pause(), "Pause or resume"),
        (
            tr::settings::shortcuts::label::restart(),
            "Restart recording",
        ),
        (tr::settings::shortcuts::label::fallback(), "Shortcut"),
        (
            tr::settings::shortcuts::needs_modifier_macos(),
            "Include ⌘, ⌃ or ⌥ so the shortcut doesn't get in the way of typing.",
        ),
        (
            tr::settings::shortcuts::needs_modifier_other(),
            "Include Ctrl, Alt or Win so the shortcut doesn't get in the way of typing.",
        ),
        (
            tr::settings::shortcuts::unsupported_key(),
            "That key can't be used in a shortcut. Try a letter, number or F-key.",
        ),
        (
            tr::settings::shortcuts::recording_hint(),
            "Press the keys you want to use. Esc cancels, Delete removes it.",
        ),
        (
            tr::settings::shortcuts::blocked_while_recording(),
            "Shortcuts can't be changed while this recording holds its stop key. Stop recording first.",
        ),
        (
            tr::settings::shortcuts::unavailable(),
            "Another app or the system already uses this shortcut. Click to choose a different one.",
        ),
        (tr::settings::shortcuts::type_shortcut(), "Type shortcut…"),
        (
            tr::settings::shortcuts::record_shortcut(),
            "Record shortcut",
        ),
        (tr::settings::cli::title(), "Command Line"),
        (
            tr::settings::cli::description(),
            "Install the Cap command for terminals, agents, scripts, and local automation.",
        ),
        (tr::settings::cli::retry(), "Retry"),
        (tr::settings::cli::repairing(), "Repairing..."),
        (tr::settings::cli::installing(), "Installing..."),
        (tr::settings::cli::repair(), "Repair"),
        (tr::settings::cli::install(), "Install CLI"),
        (tr::settings::cli::installed(), "Installed"),
        (tr::settings::cli::not_installed(), "Not installed"),
        (tr::settings::cli::removing(), "Removing..."),
        (tr::settings::cli::remove(), "Remove"),
        (tr::settings::cli::command(), "Command"),
        (tr::settings::cli::target(), "Target"),
        (
            tr::settings::cli::path_configured(),
            "Added cap to your PATH. Restart your terminal to use it, or run this now:",
        ),
        (tr::settings::cli::copy(), "Copy"),
        (tr::settings::transcription::title(), "Transcription"),
        (
            tr::settings::transcription::description(),
            "Add names, spellings, domains, and capitalization preferences that caption generation should keep in mind.",
        ),
        (
            tr::settings::transcription::terms_title(),
            "Remembered terms",
        ),
        (
            tr::settings::transcription::terms_description(),
            "Add one term at a time to reduce typos and formatting mistakes.",
        ),
        (tr::settings::transcription::clear(), "Clear"),
        (tr::settings::transcription::saving(), "Saving..."),
        (tr::settings::transcription::saved(), "Saved"),
        (tr::settings::transcription::placeholder(), "Add a term"),
        (
            tr::settings::transcription::applied_note(),
            "These hints are applied when you generate captions in the editor.",
        ),
        (tr::settings::transcription::active_title(), "Active hints"),
        (tr::settings::experimental::reliability(), "Reliability"),
        (tr::settings::experimental::muxer(), "Out-of-process muxer"),
        (
            tr::settings::experimental::muxer_description(),
            "Run the fragmented-MP4 muxer in an isolated subprocess so muxer crashes can't take down your recording. Requires the bundled cap-muxer binary.",
        ),
        (tr::settings::experimental::developer(), "Developer"),
        (
            tr::settings::experimental::developer_description(),
            "Only shown in development builds.",
        ),
        (tr::settings::experimental::native_app(), "Use native app"),
        (
            tr::settings::experimental::native_app_description(),
            "Turn off to close this app and reopen the classic Tauri app in the dev harness. Recordings and settings are shared.",
        ),
        (
            tr::settings::experimental::switch::switching(),
            "Switching back to the classic Cap app.",
        ),
        (
            tr::settings::experimental::switch::data_stays(),
            "Your recordings and settings stay exactly where they are.",
        ),
        (
            tr::settings::experimental::switch::opening(),
            "Opening the classic Cap app",
        ),
        (
            tr::settings::experimental::switch::opening_detail(),
            "This window will close when the classic Cap app is ready.",
        ),
        (
            tr::settings::experimental::switch::busy(),
            "Finish your recording, export, upload, import, or transcription task before switching to the classic app.",
        ),
        (
            tr::settings::experimental::switch::not_found(),
            "Couldn't find the classic Cap app to switch back to.",
        ),
        (
            tr::settings::experimental::switch::save_failed(),
            "Couldn't save your app preference. Cap is still open.",
        ),
        (
            tr::settings::experimental::switch::timed_out(),
            "The classic app hasn't opened. Check the dev terminal for build errors, then try again.",
        ),
        (
            tr::settings::experimental::switch::failed(),
            "Couldn't open the classic Cap app.",
        ),
        (tr::settings::feedback::title(), "Feedback"),
        (
            tr::settings::feedback::description(),
            "Help us improve Cap by submitting feedback or reporting bugs. We'll get right on it.",
        ),
        (
            tr::settings::feedback::placeholder(),
            "Tell us what you think about Cap...",
        ),
        (
            tr::settings::feedback::submit_failed(),
            "Failed to submit feedback",
        ),
        (
            tr::settings::feedback::thanks(),
            "Thank you for your feedback!",
        ),
        (tr::settings::feedback::submitting(), "Submitting..."),
        (tr::settings::feedback::submit(), "Submit Feedback"),
        (
            tr::settings::feedback::community_title(),
            "Join the Community",
        ),
        (
            tr::settings::feedback::community_description(),
            "Have questions, want to share ideas, or just hang out? Join the Cap Discord community.",
        ),
        (tr::settings::feedback::join_discord(), "Join Discord"),
        (tr::settings::feedback::debug_title(), "Debug Information"),
        (
            tr::settings::feedback::debug_description(),
            "Upload your logs to help us diagnose issues with Cap. No personal information is included.",
        ),
        (tr::settings::feedback::uploading(), "Uploading..."),
        (tr::settings::feedback::upload_logs(), "Upload Logs"),
        (
            tr::settings::feedback::upload_sent(),
            "Sent. Thank you -- this helps us find the problem.",
        ),
        (
            tr::settings::feedback::upload_interrupted(),
            "The upload was interrupted",
        ),
        (tr::settings::feedback::system_title(), "System Information"),
        (
            tr::settings::feedback::system_loading(),
            "Loading system information...",
        ),
        (
            tr::settings::feedback::operating_system(),
            "Operating System",
        ),
        (tr::settings::feedback::capture_support(), "Capture Support"),
        (tr::settings::feedback::app_version(), "App Version"),
        (
            tr::settings::feedback::diagnostic::title(),
            "Diagnostic Report",
        ),
        (
            tr::settings::feedback::diagnostic::description(),
            "Records a short flashing/beeping test pattern, measures how far the picture and sound drift apart, and snapshots your displays, cameras, microphones, disk space and recording settings. Nothing is sent anywhere until you choose to send it.",
        ),
        (
            tr::settings::feedback::diagnostic::stop_recording_first(),
            "Stop the current recording before running a diagnostic.",
        ),
        (
            tr::settings::feedback::diagnostic::confirm_title(),
            "Run diagnostic?",
        ),
        (tr::settings::feedback::diagnostic::run(), "Run Diagnostic"),
        (
            tr::settings::feedback::diagnostic::no_cli(),
            "The Cap command-line tool was not found next to this build, so the report will cover your environment only.",
        ),
        (
            tr::settings::feedback::diagnostic::no_cli_sync(),
            "The Cap command-line tool was not found next to this build, so the sync test could not run.",
        ),
        (
            tr::settings::feedback::diagnostic::warning_title(),
            "The test takes over your screen and makes noise.",
        ),
        (
            tr::settings::feedback::diagnostic::warning_body(),
            "A fullscreen window flashes black and white while 1kHz beeps play through your speakers, and Cap records it and measures how far the picture and the sound have drifted apart. Leave the machine alone while it runs. Both modes together take a couple of minutes.",
        ),
        (
            tr::settings::feedback::diagnostic::mode_label(),
            "Recording mode",
        ),
        (
            tr::settings::feedback::diagnostic::mode_description(),
            "Which pipeline to test. Both runs the studio leg and then the instant one.",
        ),
        (
            tr::settings::feedback::diagnostic::mic_label(),
            "Test microphone",
        ),
        (
            tr::settings::feedback::diagnostic::mic_description(),
            "Also record your microphone and check that it hears the beeps in time. Needs speakers the mic can actually hear.",
        ),
        (tr::settings::feedback::diagnostic::sending(), "Sending..."),
        (tr::settings::feedback::diagnostic::send(), "Send to Cap"),
        (tr::settings::feedback::diagnostic::show_file(), "Show File"),
        (tr::settings::feedback::diagnostic::run_again(), "Run Again"),
        (tr::settings::feedback::diagnostic::try_again(), "Try Again"),
        (tr::settings::feedback::diagnostic::verdict::pass(), "PASS"),
        (tr::settings::feedback::diagnostic::verdict::warn(), "WARN"),
        (tr::settings::feedback::diagnostic::verdict::fail(), "FAIL"),
        (
            tr::settings::feedback::diagnostic::verdict::inconclusive(),
            "INCONCLUSIVE",
        ),
        (
            tr::settings::feedback::diagnostic::verdict::environment_only(),
            "ENVIRONMENT ONLY",
        ),
        (tr::settings::sign_in_required::title(), "Sign in required"),
        (
            tr::settings::sign_in_required::body(),
            "Please sign in to continue. Alternatively, email hello@cap.so or join our Discord at cap.link/discord",
        ),
        (tr::settings::changelog::loading(), "Loading changelog..."),
        (
            tr::settings::changelog::fetch_failed(),
            "Failed to fetch changelog",
        ),
        (tr::settings::changelog::new(), "NEW"),
        (tr::settings::license::title(), "Plan & license"),
        (
            tr::settings::license::description(),
            "Your Cap plan and desktop license, in one place.",
        ),
        (tr::settings::license::plan_title(), "Your plan"),
        (
            tr::settings::license::pro_description(),
            "Your account includes cloud sharing, Pro features and a desktop license for commercial use.",
        ),
        (tr::settings::license::desktop_name(), "Desktop License"),
        (
            tr::settings::license::desktop_description(),
            "Your desktop license covers commercial recording and editing. Cap Pro adds cloud sharing and collaboration features.",
        ),
        (
            tr::settings::license::free_description(),
            "Record and edit locally for personal use. Choose a paid plan for commercial use or more cloud features.",
        ),
        (tr::settings::license::checking(), "Checking…"),
        (tr::settings::license::refresh(), "Refresh plan"),
        (
            tr::settings::license::refresh_failed(),
            "Couldn't refresh your plan. Please try again.",
        ),
        (
            tr::settings::license::sign_in_hint(),
            "Already have Cap Pro? Sign in with your account from the sidebar.",
        ),
        (tr::settings::license::explore_title(), "Explore plans"),
        (
            tr::settings::license::explore_description(),
            "Compare current pricing and everything included on our website.",
        ),
        (
            tr::settings::license::explore_desktop(),
            "Desktop License · Commercial use of the desktop recorder and editor.",
        ),
        (
            tr::settings::license::explore_pro(),
            "Cap Pro · A desktop license, plus cloud sharing, AI features and collaboration.",
        ),
        (
            tr::settings::license::view_pricing(),
            "View plans & pricing ↗",
        ),
        (
            tr::settings::license::opens_pricing(),
            "Opens cap.so/pricing in your browser.",
        ),
        (tr::settings::license::active_title(), "Desktop license"),
        (tr::settings::license::key(), "License Key"),
        (tr::settings::license::expires(), "Expires"),
        (tr::settings::license::deactivate(), "Deactivate License"),
        (tr::settings::license::have_key(), "Have a license key?"),
        (tr::settings::license::placeholder(), "License key"),
        (tr::settings::license::activating(), "Activating..."),
        (tr::settings::license::activate(), "Activate License"),
        (tr::settings::license::no_instance(), "No instance ID found"),
        (
            tr::settings::license::save_failed(),
            "Failed to save the license",
        ),
        (tr::settings::integrations::title(), "Integrations"),
        (
            tr::settings::integrations::description(),
            "Configure integrations to extend Cap's functionality and connect with third-party services.",
        ),
        (
            tr::settings::integrations::google_drive_description(),
            "Connect Google Drive for new shareable link uploads. Cap stores new videos in a private Cap folder in your Drive and continues serving them through Cap after normal access checks.",
        ),
        (tr::settings::integrations::s3_name(), "S3 Config"),
        (
            tr::settings::integrations::s3_description(),
            "Connect your own S3 bucket for complete control over your data storage. All new shareable link uploads will be automatically uploaded to your configured S3 bucket, ensuring you maintain complete ownership and control over your content. Perfect for organizations requiring data sovereignty and custom storage policies.",
        ),
        (
            tr::settings::integrations::managed(),
            "Managed by your organization",
        ),
        (tr::settings::integrations::upgrade(), "Upgrade to Pro"),
        (tr::settings::integrations::configure(), "Configure"),
        (
            tr::settings::integrations::request_timed_out(),
            "The request timed out",
        ),
        (
            tr::settings::integrations::s3::configuration(),
            "Configuration",
        ),
        (
            tr::settings::integrations::s3::guide(),
            "Storage Config Guide",
        ),
        (
            tr::settings::integrations::s3::provider(),
            "Storage Provider",
        ),
        (
            tr::settings::integrations::s3::other_provider(),
            "Other S3-Compatible",
        ),
        (
            tr::settings::integrations::s3::access_key(),
            "Access Key ID",
        ),
        (
            tr::settings::integrations::s3::secret_key(),
            "Secret Access Key",
        ),
        (tr::settings::integrations::s3::endpoint(), "Endpoint"),
        (tr::settings::integrations::s3::bucket(), "Bucket Name"),
        (tr::settings::integrations::s3::region(), "Region"),
        (tr::settings::integrations::s3::removing(), "Removing..."),
        (tr::settings::integrations::s3::remove(), "Remove Config"),
        (tr::settings::integrations::s3::testing(), "Testing..."),
        (tr::settings::integrations::s3::test(), "Test Connection"),
        (tr::settings::integrations::s3::saving(), "Saving..."),
        (
            tr::settings::integrations::s3::fetch_failed(),
            "Failed to fetch S3 config",
        ),
        (
            tr::settings::integrations::s3::saved(),
            "S3 configuration saved successfully",
        ),
        (
            tr::settings::integrations::s3::save_failed(),
            "Failed to save S3 config",
        ),
        (
            tr::settings::integrations::s3::deleted(),
            "S3 configuration deleted successfully",
        ),
        (
            tr::settings::integrations::s3::delete_failed(),
            "Failed to delete S3 config",
        ),
        (
            tr::settings::integrations::s3::test_ok(),
            "S3 configuration test successful! Connection is working.",
        ),
        (
            tr::settings::integrations::s3::test_failed(),
            "S3 connection test failed. Check your config and network connection.",
        ),
        (
            tr::settings::integrations::s3::test_timeout(),
            "Connection test timed out after 5 seconds. Please check your endpoint URL and network connection.",
        ),
        (
            tr::settings::integrations::gdrive::connection_title(),
            "Connection",
        ),
        (
            tr::settings::integrations::gdrive::connection_description(),
            "Google Drive stores new uploads in a private Cap folder in your Drive. Existing Cap-hosted and S3 videos keep using their current storage.",
        ),
        (
            tr::settings::integrations::gdrive::active_for_uploads(),
            "Active for new uploads",
        ),
        (
            tr::settings::integrations::gdrive::connected_inactive(),
            "Connected but not active",
        ),
        (
            tr::settings::integrations::gdrive::not_connected(),
            "Not connected",
        ),
        (
            tr::settings::integrations::gdrive::refreshing(),
            "Refreshing...",
        ),
        (tr::settings::integrations::gdrive::refresh(), "Refresh"),
        (tr::settings::integrations::gdrive::waiting(), "Waiting..."),
        (tr::settings::integrations::gdrive::opening(), "Opening..."),
        (
            tr::settings::integrations::gdrive::connect(),
            "Connect Google Drive",
        ),
        (tr::settings::integrations::gdrive::active(), "Active"),
        (
            tr::settings::integrations::gdrive::use_drive(),
            "Use Google Drive",
        ),
        (tr::settings::integrations::gdrive::use_s3(), "Use S3"),
        (tr::settings::integrations::gdrive::testing(), "Testing..."),
        (tr::settings::integrations::gdrive::test(), "Test"),
        (
            tr::settings::integrations::gdrive::disconnect(),
            "Disconnect",
        ),
        (
            tr::settings::integrations::gdrive::connect_failed(),
            "Failed to start Google Drive connection",
        ),
        (
            tr::settings::integrations::gdrive::finish_in_browser(),
            "Finish connecting Google Drive in your browser, then return here and refresh.",
        ),
        (
            tr::settings::integrations::gdrive::working(),
            "Google Drive connection is working",
        ),
        (
            tr::settings::integrations::gdrive::test_failed(),
            "Google Drive connection test failed",
        ),
        (
            tr::settings::integrations::gdrive::set_active_failed(),
            "Failed to update active storage provider",
        ),
        (
            tr::settings::integrations::gdrive::disconnected(),
            "Google Drive disconnected",
        ),
        (
            tr::settings::integrations::gdrive::disconnect_failed(),
            "Failed to disconnect Google Drive",
        ),
        (tr::settings::integrations::gdrive::storage(), "Storage"),
        (tr::settings::integrations::gdrive::remaining(), "Remaining"),
        (
            tr::settings::integrations::gdrive::drive_files(),
            "Drive files",
        ),
        (tr::settings::integrations::gdrive::trash(), "Trash"),
        (tr::settings::automations::title(), "Automations"),
        (
            tr::settings::automations::description(),
            "Rules are shared with the Cap CLI. Cap saves these rules but does not run automations yet.",
        ),
        (tr::settings::automations::templates_title(), "Templates"),
        (
            tr::settings::automations::templates_description(),
            "One click to add a ready-made automation. Tweak anything afterwards.",
        ),
        (
            tr::settings::automations::save_failed(),
            "Failed to save automations. Your changes have not been saved.",
        ),
        (tr::settings::automations::retry_save(), "Retry save"),
        (
            tr::settings::automations::empty_title(),
            "No automations yet",
        ),
        (
            tr::settings::automations::empty_description(),
            "Pick a template below to get started in one click, or build your own from scratch.",
        ),
        (
            tr::settings::automations::start_from_scratch(),
            "Start from scratch",
        ),
        (tr::settings::automations::new(), "New automation"),
        (
            tr::settings::automations::status::enabled_saved(),
            "Enabled · Saved",
        ),
        (
            tr::settings::automations::status::disabled_saved(),
            "Disabled · Saved",
        ),
        (
            tr::settings::automations::status::enabled_unsaved(),
            "Enabled · Not saved",
        ),
        (
            tr::settings::automations::status::disabled_unsaved(),
            "Disabled · Not saved",
        ),
        (tr::settings::automations::enabled(), "Enabled"),
        (tr::settings::automations::name(), "Name"),
        (tr::settings::automations::match_all(), "Match all"),
        (tr::settings::automations::match_any(), "Match any"),
        (tr::settings::automations::add_condition(), "Add condition"),
        (tr::settings::automations::add_action(), "Add action"),
        (
            tr::settings::automations::check_compatibility(),
            "Check compatibility",
        ),
        (tr::settings::automations::delete(), "Delete"),
        (
            tr::settings::automations::dangerous(),
            "In the Cap CLI, this automation runs commands or sends network requests with your permissions. Only use values you trust.",
        ),
        (
            tr::settings::automations::compatibility_checked(),
            "Compatibility checked: this automation doesn't run in Cap yet. Saved rules remain available to the Cap CLI. No actions were run.",
        ),
        (
            tr::settings::automations::condition_never_matches(),
            "This condition never matches for the selected trigger.",
        ),
        (
            tr::settings::automations::action_no_effect(),
            "This action has no effect for the selected trigger.",
        ),
        (tr::settings::automations::browse(), "Browse"),
        (
            tr::settings::automations::copy_link(),
            "Copy link to clipboard",
        ),
        (
            tr::settings::automations::open_in_browser(),
            "Open in browser",
        ),
        (
            tr::settings::automations::run_through_shell(),
            "Run through shell",
        ),
        (
            tr::settings::automations::no_presets(),
            "No presets yet — create one in the editor first.",
        ),
        (tr::settings::automations::field::source(), "Source"),
        (tr::settings::automations::field::folder(), "Folder"),
        (
            tr::settings::automations::field::filename(),
            "Filename template (optional)",
        ),
        (
            tr::settings::automations::field::organization(),
            "Organization ID (optional)",
        ),
        (tr::settings::automations::field::program(), "Program"),
        (
            tr::settings::automations::field::arguments(),
            "Arguments (space-separated)",
        ),
        (tr::settings::automations::field::url(), "URL"),
        (tr::settings::automations::field::method(), "Method"),
        (
            tr::settings::automations::field::body_template(),
            "Body template (optional)",
        ),
        (tr::settings::automations::field::title(), "Title"),
        (tr::settings::automations::field::body(), "Body"),
        (tr::settings::automations::field::preset(), "Preset"),
        (tr::settings::automations::field::format(), "Format"),
        (tr::settings::automations::field::resolution(), "Resolution"),
        (tr::settings::automations::field::frame_rate(), "Frame rate"),
        (
            tr::settings::automations::field::compression(),
            "Compression",
        ),
        (
            tr::settings::automations::field::destination(),
            "Destination folder (optional, blank = project folder)",
        ),
        (
            tr::settings::automations::placeholder::window_title(),
            "e.g. Slack",
        ),
        (
            tr::settings::automations::placeholder::organization_id(),
            "Organization ID",
        ),
        (
            tr::settings::automations::placeholder::project_folder(),
            "Project folder",
        ),
        (
            tr::settings::automations::clipboard::original(),
            "Original capture",
        ),
        (
            tr::settings::automations::clipboard::rendered(),
            "Edited / rendered",
        ),
        (tr::settings::automations::target::display(), "Display"),
        (tr::settings::automations::target::window(), "Window"),
        (tr::settings::automations::target::area(), "Area"),
        (tr::settings::automations::compression::maximum(), "Maximum"),
        (tr::settings::automations::compression::social(), "Social"),
        (tr::settings::automations::compression::web(), "Web"),
        (tr::settings::automations::compression::potato(), "Potato"),
        (
            tr::settings::automations::trigger::screenshot_taken::label(),
            "On screenshot taken",
        ),
        (
            tr::settings::automations::trigger::screenshot_taken::phrase(),
            "Screenshot taken",
        ),
        (
            tr::settings::automations::trigger::screenshot_taken::noun(),
            "Screenshot",
        ),
        (
            tr::settings::automations::trigger::studio_finished::label(),
            "On studio recording finished",
        ),
        (
            tr::settings::automations::trigger::studio_finished::phrase(),
            "Studio recording ends",
        ),
        (
            tr::settings::automations::trigger::studio_finished::noun(),
            "Studio recording",
        ),
        (
            tr::settings::automations::trigger::instant_finished::label(),
            "On instant recording finished",
        ),
        (
            tr::settings::automations::trigger::instant_finished::phrase(),
            "Instant recording ends",
        ),
        (
            tr::settings::automations::trigger::instant_finished::noun(),
            "Instant recording",
        ),
        (
            tr::settings::automations::trigger::recording_started::label(),
            "On recording started",
        ),
        (
            tr::settings::automations::trigger::recording_started::phrase(),
            "Recording starts",
        ),
        (
            tr::settings::automations::trigger::recording_started::noun(),
            "Recording start",
        ),
        (
            tr::settings::automations::trigger::upload_completed::label(),
            "On upload completed",
        ),
        (
            tr::settings::automations::trigger::upload_completed::phrase(),
            "Upload completes",
        ),
        (
            tr::settings::automations::trigger::upload_completed::noun(),
            "Upload",
        ),
        (
            tr::settings::automations::trigger::video_imported::label(),
            "On video imported",
        ),
        (
            tr::settings::automations::trigger::video_imported::phrase(),
            "Video imported",
        ),
        (
            tr::settings::automations::trigger::video_imported::noun(),
            "Import",
        ),
        (
            tr::settings::automations::trigger::recording_deleted::label(),
            "On recording deleted",
        ),
        (
            tr::settings::automations::trigger::recording_deleted::phrase(),
            "Recording deleted",
        ),
        (
            tr::settings::automations::trigger::recording_deleted::noun(),
            "Deletion",
        ),
        (
            tr::settings::automations::action::copy_to_clipboard::label(),
            "Copy to clipboard",
        ),
        (
            tr::settings::automations::action::copy_to_clipboard::short(),
            "Copy to clipboard",
        ),
        (
            tr::settings::automations::action::copy_to_clipboard::noun(),
            "Clipboard",
        ),
        (
            tr::settings::automations::action::save_to_location::label(),
            "Save to location",
        ),
        (
            tr::settings::automations::action::save_to_location::short(),
            "Save to folder",
        ),
        (
            tr::settings::automations::action::save_to_location::noun(),
            "Folder",
        ),
        (
            tr::settings::automations::action::export::label(),
            "Export with profile",
        ),
        (tr::settings::automations::action::export::short(), "Export"),
        (tr::settings::automations::action::export::noun(), "Export"),
        (
            tr::settings::automations::action::upload::label(),
            "Upload + copy link",
        ),
        (
            tr::settings::automations::action::upload::short(),
            "Upload & copy link",
        ),
        (tr::settings::automations::action::upload::noun(), "Upload"),
        (
            tr::settings::automations::action::reveal::label(),
            "Reveal in file manager",
        ),
        (
            tr::settings::automations::action::reveal::short(),
            "Reveal in file manager",
        ),
        (tr::settings::automations::action::reveal::noun(), "Reveal"),
        (
            tr::settings::automations::action::open_file::label(),
            "Open file",
        ),
        (
            tr::settings::automations::action::open_file::short(),
            "Open file",
        ),
        (tr::settings::automations::action::open_file::noun(), "Open"),
        (
            tr::settings::automations::action::ocr::label(),
            "Recognize text (OCR) to clipboard",
        ),
        (
            tr::settings::automations::action::ocr::short(),
            "Copy text (OCR)",
        ),
        (tr::settings::automations::action::ocr::noun(), "Text"),
        (
            tr::settings::automations::action::notify::label(),
            "Show notification",
        ),
        (tr::settings::automations::action::notify::short(), "Notify"),
        (tr::settings::automations::action::notify::noun(), "Notify"),
        (
            tr::settings::automations::action::open_editor::label(),
            "Open editor",
        ),
        (
            tr::settings::automations::action::open_editor::short(),
            "Open editor",
        ),
        (
            tr::settings::automations::action::open_editor::noun(),
            "Editor",
        ),
        (
            tr::settings::automations::action::skip_editor::label(),
            "Skip editor (headless)",
        ),
        (
            tr::settings::automations::action::skip_editor::short(),
            "Skip editor",
        ),
        (
            tr::settings::automations::action::skip_editor::noun(),
            "Skip editor",
        ),
        (
            tr::settings::automations::action::apply_preset::label(),
            "Apply editor preset",
        ),
        (
            tr::settings::automations::action::apply_preset::short(),
            "Apply preset",
        ),
        (
            tr::settings::automations::action::apply_preset::noun(),
            "Preset",
        ),
        (
            tr::settings::automations::action::run_command::label(),
            "Run command",
        ),
        (
            tr::settings::automations::action::run_command::short(),
            "Run command",
        ),
        (
            tr::settings::automations::action::run_command::noun(),
            "Command",
        ),
        (
            tr::settings::automations::action::webhook::label(),
            "Send webhook",
        ),
        (
            tr::settings::automations::action::webhook::short(),
            "Send webhook",
        ),
        (
            tr::settings::automations::action::webhook::noun(),
            "Webhook",
        ),
        (
            tr::settings::automations::action::delete_local_files::label(),
            "Delete local files",
        ),
        (
            tr::settings::automations::action::delete_local_files::short(),
            "Delete local files",
        ),
        (
            tr::settings::automations::action::delete_local_files::noun(),
            "Delete",
        ),
        (
            tr::settings::automations::condition::capture_target(),
            "Capture target is",
        ),
        (
            tr::settings::automations::condition::recording_mode(),
            "Recording mode is",
        ),
        (
            tr::settings::automations::condition::duration_at_least(),
            "Duration at least (seconds)",
        ),
        (
            tr::settings::automations::condition::duration_at_most(),
            "Duration at most (seconds)",
        ),
        (
            tr::settings::automations::condition::window_title(),
            "Window title contains",
        ),
        (
            tr::settings::automations::condition::organization(),
            "Organization is",
        ),
        (
            tr::settings::automations::template::copy_screenshot::name(),
            "Auto-copy new screenshots to clipboard",
        ),
        (
            tr::settings::automations::template::copy_screenshot::description(),
            "Snap a screenshot and it's right there, ready to paste.",
        ),
        (
            tr::settings::automations::template::ocr_screenshot::name(),
            "Pull the text out of screenshots",
        ),
        (
            tr::settings::automations::template::ocr_screenshot::description(),
            "Cap reads the text in your screenshot and copies it for you.",
        ),
        (
            tr::settings::automations::template::save_screenshot::name(),
            "Tuck screenshots into a folder",
        ),
        (
            tr::settings::automations::template::save_screenshot::description(),
            "Send every new screenshot straight to a folder you pick.",
        ),
        (
            tr::settings::automations::template::reveal_screenshot::name(),
            "Jump to each new screenshot",
        ),
        (
            tr::settings::automations::template::reveal_screenshot::description(),
            "Pop open every screenshot in Finder the moment you take it.",
        ),
        (
            tr::settings::automations::template::export_studio::name(),
            "Auto-export when you finish recording",
        ),
        (
            tr::settings::automations::template::export_studio::description(),
            "Render an MP4 the second a Studio recording wraps up.",
        ),
        (
            tr::settings::automations::template::upload_share::name(),
            "Upload and grab the share link",
        ),
        (
            tr::settings::automations::template::upload_share::description(),
            "Finish a recording and the link is waiting on your clipboard.",
        ),
        (
            tr::settings::automations::template::notify_upload::name(),
            "Ping me when an upload is ready",
        ),
        (
            tr::settings::automations::template::notify_upload::description(),
            "Get a gentle desktop nudge once your recording is shareable.",
        ),
        (
            tr::settings::automations::template::notify_upload::body(),
            "Your recording is ready to share.",
        ),
        (
            tr::settings::automations::template::webhook_share::name(),
            "Tell Slack when you share something",
        ),
        (
            tr::settings::automations::template::webhook_share::description(),
            "Send the share link to Slack, Discord, or your own webhook.",
        ),
    ];
    for (translated, literal) in pairs {
        assert_eq!(translated, literal);
    }

    let assembled: &[(&str, String)] = &[
        (
            tr::settings::recordings::empty::studio_matching(),
            format!("No matching {} recordings", "studio"),
        ),
        (
            tr::settings::feedback::capture_supported(),
            format!("Screen Capture: {}", "Supported"),
        ),
        (
            tr::settings::feedback::capture_unsupported(),
            format!("Screen Capture: {}", "Not Supported"),
        ),
        (
            tr::settings::automations::when(),
            "When this happens".to_uppercase(),
        ),
        (
            tr::settings::automations::only_if(),
            "Only run if".to_uppercase(),
        ),
        (
            tr::settings::automations::then(),
            "Then do this".to_uppercase(),
        ),
    ];
    for (translated, literal) in assembled {
        assert_eq!(*translated, literal.as_str());
    }

    use tr::settings::automations::trigger;
    let runs = [
        (trigger::screenshot_taken::runs(), "Screenshot taken"),
        (trigger::studio_finished::runs(), "Studio recording ends"),
        (trigger::instant_finished::runs(), "Instant recording ends"),
        (trigger::recording_started::runs(), "Recording starts"),
        (trigger::upload_completed::runs(), "Upload completes"),
        (trigger::video_imported::runs(), "Video imported"),
        (trigger::recording_deleted::runs(), "Recording deleted"),
    ];
    for (translated, phrase) in runs {
        assert_eq!(
            translated,
            format!("Runs for every {}.", phrase.to_lowercase())
        );
    }

    let plain_keys = KEYS
        .iter()
        .filter(|key| is_settings_surface_key(key))
        .filter(|key| !EFFECT_PREFIXES.iter().any(|prefix| key.starts_with(prefix)))
        .count()
        - FORMATTED.len();
    assert_eq!(
        pairs.len() + assembled.len() + runs.len(),
        plain_keys,
        "every plain key has a literal above"
    );
    for key in FORMATTED {
        assert!(KEYS.contains(key), "{key}");
    }
}

#[test]
fn settings_surface_messages_format_like_the_code_they_replaced() {
    let version = "0.6.2";
    assert_eq!(
        tr::settings::sidebar::downloading(version),
        format!("Downloading v{version}…")
    );
    for fraction in [0.0_f32, 0.425, 1.0] {
        assert_eq!(
            tr::settings::sidebar::downloading_progress(version, (fraction * 100.).round() as u32),
            format!(
                "Downloading v{version}… {}%",
                (fraction * 100.).round() as u32
            )
        );
    }
    assert_eq!(
        tr::settings::sidebar::restart_to_update(version),
        format!("Restart to update to v{version}")
    );
    assert_eq!(
        tr::settings::sidebar::installing(version),
        format!("Installing v{version}…")
    );

    let keys = "⌘⇧4".to_string();
    let effect = tr::settings::shortcuts::effect::screenshot_area_copy();
    let mut moved = format!("Saved. Press {} in any app to {effect}.", keys);
    assert_eq!(tr::settings::shortcuts::saved(&keys, effect), moved);
    let from = tr::settings::shortcuts::label::record_area();
    moved.push_str(&format!(" Removed from {}.", from));
    assert_eq!(
        tr::settings::shortcuts::saved_moved(&keys, effect, from),
        moved
    );

    let error = "permission denied".to_string();
    assert_eq!(
        tr::settings::cli::load_failed(&error),
        format!("Couldn't load CLI status: {error}")
    );
    assert_eq!(
        tr::settings::experimental::switch::open_failed(&error),
        format!("Couldn't open the classic Cap app: {error}")
    );
    assert_eq!(
        tr::settings::experimental::switch::check_failed(&error),
        format!("Couldn't check whether the classic Cap app opened: {error}")
    );
    let path_entry = "~/.local/bin".to_string();
    assert_eq!(
        tr::settings::cli::path_missing(&path_entry),
        format!(
            "Add {} to your PATH to use cap from a new terminal.",
            path_entry
        )
    );

    let marker = "\u{1}";
    let installs = tr::settings::cli::installs_command(marker);
    assert_eq!(
        installs.split_once(marker),
        Some((
            "The desktop app installs a local\u{a0}",
            "\u{a0}command that points back to the bundled CLI."
        ))
    );
    let guide = tr::settings::integrations::s3::guide_intro(marker);
    assert_eq!(
        guide.split_once(marker),
        Some((
            "It should take under 10 minutes to set up and connect your storage \
             bucket to Cap. View the\u{a0}",
            "\u{a0}to get started."
        ))
    );

    for count in [0_usize, 1, 2, 5] {
        assert_eq!(
            tr::settings::transcription::count(count),
            format!("{} {}", count, if count == 1 { "item" } else { "items" })
        );
    }

    assert_eq!(
        tr::settings::feedback::diagnostic::confirm_body(crate::diagnostics::DEFAULT_DURATION_SECS),
        format!(
            "Cap will take over your screen with a flashing pattern and play loud beeps for \
             about {} seconds per pipeline. Take your headphones off, leave the volume \
             audible, and leave the machine alone until it finishes.",
            crate::diagnostics::DEFAULT_DURATION_SECS
        )
    );

    let date = "8/17/2026".to_string();
    assert_eq!(
        tr::settings::changelog::version("0.6.2", &date),
        format!("Version {} - {}", "0.6.2", date)
    );

    let organization = "Acme".to_string();
    assert_eq!(
        tr::settings::integrations::managed_by(&organization),
        format!("Managed by your organization: {organization}")
    );
    let email = "taylor@example.com";
    assert_eq!(
        tr::settings::integrations::gdrive::working_for(email),
        format!("Google Drive connection is working for {email}")
    );
    let (usage, limit) = ("2.0 GB".to_string(), "15 GB".to_string());
    assert_eq!(
        tr::settings::integrations::gdrive::used_of(&usage, &limit),
        format!("{usage} of {limit} used")
    );
    assert_eq!(
        tr::settings::integrations::gdrive::used(&usage),
        format!("{usage} used")
    );
    let formatted = "Aug 17, 2026, 10:30 PM".to_string();
    assert_eq!(
        tr::settings::integrations::gdrive::cached(&formatted),
        format!("{} {formatted}", "Cached")
    );
    assert_eq!(
        tr::settings::integrations::gdrive::updated(&formatted),
        format!("{} {formatted}", "Updated")
    );

    use tr::settings::automations::trigger;
    for (phrase, noun) in [
        (
            trigger::screenshot_taken::phrase(),
            trigger::screenshot_taken::noun(),
        ),
        (
            trigger::studio_finished::phrase(),
            trigger::studio_finished::noun(),
        ),
        (
            trigger::instant_finished::phrase(),
            trigger::instant_finished::noun(),
        ),
        (
            trigger::recording_started::phrase(),
            trigger::recording_started::noun(),
        ),
        (
            trigger::upload_completed::phrase(),
            trigger::upload_completed::noun(),
        ),
        (
            trigger::video_imported::phrase(),
            trigger::video_imported::noun(),
        ),
        (
            trigger::recording_deleted::phrase(),
            trigger::recording_deleted::noun(),
        ),
    ] {
        assert_eq!(
            tr::settings::automations::summary_empty(phrase),
            format!("{phrase} → no actions yet")
        );
        assert_eq!(
            tr::settings::automations::auto_name_empty(noun),
            format!("{noun} automation")
        );
    }
}
