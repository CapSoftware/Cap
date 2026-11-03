use super::*;

pub(super) fn is_dialogs_surface_key(key: &str) -> bool {
    [
        "auth.",
        "diagnostics.",
        "dialog.",
        "import.",
        "overlay.",
        "permission.",
        "screenshot_editor.",
        "transcription.",
        "upload.",
    ]
    .iter()
    .any(|prefix| key.starts_with(prefix))
}

const FORMATTED: &[&str] = &[
    "dialog.teleprompter.words_per_minute",
    "diagnostics.error.create_folder",
    "diagnostics.error.exited",
    "diagnostics.error.serialize",
    "diagnostics.error.start_failed",
    "diagnostics.error.upload_logs",
    "diagnostics.error.upload_status",
    "diagnostics.error.wait_failed",
    "diagnostics.error.write_failed",
    "dialog.open_recording_failed",
    "dialog.delete_recording.close_failed",
    "dialog.delete_recording.failed",
    "dialog.delete_recording.in_use",
    "dialog.capture.cleanup_incomplete",
    "dialog.capture.shortcut_hint",
    "dialog.clipboard.copy_file",
    "dialog.clipboard.copy_image",
    "dialog.clipboard.unavailable_error",
    "dialog.file.failed",
    "import.image_failed",
    "import.video_failed",
    "import.progress.converting",
    "overlay.display_fallback",
    "overlay.area.minimum_size",
    "overlay.area.too_small",
    "screenshot_editor.error.encode",
    "screenshot_editor.error.load_meta",
    "screenshot_editor.error.load_metadata",
    "screenshot_editor.error.no_image",
    "screenshot_editor.error.open_image",
    "screenshot_editor.error.renderer_failed",
    "screenshot_editor.error.save_project",
    "screenshot_editor.error.serialize",
    "screenshot_editor.error.too_large",
    "screenshot_editor.error.upload_task",
    "transcription.download.failed",
    "transcription.download.file_progress",
    "transcription.download.progress",
    "dialog.quit.canceled",
    "dialog.update.already_getting",
    "dialog.update.available",
    "dialog.update.check_failed",
    "dialog.update.download_failed",
    "dialog.update.failed",
    "dialog.update.install_failed",
    "dialog.update.ready",
];

#[test]
fn dialog_surfaces_match_the_literals_they_replaced() {
    let pairs: &[(&str, &str)] = &[
        (
            tr::diagnostics::already_running(),
            "A diagnostic is already running.",
        ),
        (tr::diagnostics::mode_both(), "Both"),
        (
            tr::diagnostics::error::no_output(),
            "The self-test produced no output stream",
        ),
        (
            tr::diagnostics::stage::analyzing(),
            "Analyzing the recording...",
        ),
        (
            tr::diagnostics::stage::analyzing_instant(),
            "Analyzing the instant recording...",
        ),
        (
            tr::diagnostics::stage::analyzing_studio(),
            "Analyzing the studio recording...",
        ),
        (tr::diagnostics::stage::cancelling(), "Cancelling..."),
        (
            tr::diagnostics::stage::collecting(),
            "Collecting system information...",
        ),
        (
            tr::diagnostics::stage::done(),
            "Wrapping up the sync test...",
        ),
        (
            tr::diagnostics::stage::exporting(),
            "Exporting the recording...",
        ),
        (
            tr::diagnostics::stage::exporting_instant(),
            "Exporting the instant recording...",
        ),
        (
            tr::diagnostics::stage::exporting_studio(),
            "Exporting the studio recording...",
        ),
        (
            tr::diagnostics::stage::finalizing(),
            "Finalizing the recording...",
        ),
        (
            tr::diagnostics::stage::finalizing_instant(),
            "Finalizing the instant recording...",
        ),
        (
            tr::diagnostics::stage::finalizing_studio(),
            "Finalizing the studio recording...",
        ),
        (
            tr::diagnostics::stage::pattern(),
            "Playing the test pattern...",
        ),
        (
            tr::diagnostics::stage::pattern_instant(),
            "Playing the test pattern instant...",
        ),
        (
            tr::diagnostics::stage::pattern_studio(),
            "Playing the test pattern studio...",
        ),
        (tr::diagnostics::stage::preparing(), "Preparing the test..."),
        (
            tr::diagnostics::stage::preparing_instant(),
            "Preparing the instant test...",
        ),
        (
            tr::diagnostics::stage::preparing_studio(),
            "Preparing the studio test...",
        ),
        (tr::diagnostics::stage::recording(), "Recording the test..."),
        (
            tr::diagnostics::stage::recording_instant(),
            "Recording the instant test...",
        ),
        (
            tr::diagnostics::stage::recording_studio(),
            "Recording the studio test...",
        ),
        (
            tr::diagnostics::stage::starting(),
            "Starting the diagnostic...",
        ),
        (
            tr::dialog::no_microphone_body(),
            "This recording will not include your voice.",
        ),
        (
            tr::dialog::delete_recording::already_deleting(),
            "This recording is already being deleted.",
        ),
        (
            tr::dialog::delete_recording::editor_changed(),
            "The editor changed while deletion was being confirmed. The recording was not deleted.",
        ),
        (
            tr::dialog::delete_recording::editor_closed(),
            "The editor has already closed. The recording was not deleted.",
        ),
        (
            tr::dialog::delete_recording::failed_title(),
            "Could not delete recording",
        ),
        (
            tr::dialog::delete_recording::finishing_body(),
            "Cap is waiting for recording cleanup to finish before completing this deletion.",
        ),
        (
            tr::dialog::delete_recording::finishing_title(),
            "Deletion is still finishing",
        ),
        (
            tr::dialog::delete_recording::outside_library(),
            "This recording is outside the recordings library. Its files were not changed.",
        ),
        (
            tr::dialog::delete_recording::recording_active(),
            "Finish or cancel the recording before deleting this project.",
        ),
        (
            tr::dialog::delete_recording::retained_title(),
            "Recording retained",
        ),
        (
            tr::dialog::capture::approve_shortcut(),
            "Approve a recording shortcut, or activate the Cap Stop tray icon when it appears. Recording has not started.",
        ),
        (
            tr::dialog::capture::area_unavailable(),
            "The selected area changed or is no longer available. Select it again.",
        ),
        (
            tr::dialog::capture::camera_needs_x11(),
            "Instant camera overlays require an X11 desktop on Linux",
        ),
        (
            tr::dialog::capture::camera_notice(),
            "Cap will hide its camera preview and recording controls. Any selected camera will keep recording as a separate editable track.",
        ),
        (
            tr::dialog::capture::camera_notice_instant(),
            "Cap will hide its preview and controls. Any selected camera will appear at its preview position with the selected shape and effects. Keep the whole preview inside the capture area. Opening Cap will stop this Instant recording before showing its controls.",
        ),
        (
            tr::dialog::capture::camera_outside_area(),
            "Move the whole camera preview inside the capture area before starting Instant recording",
        ),
        (
            tr::dialog::capture::camera_preview_closed(),
            "Open the selected camera preview before Instant recording",
        ),
        (
            tr::dialog::capture::devices_changed(),
            "Selected devices changed. Start again to confirm the new recording inputs.",
        ),
        (
            tr::dialog::capture::devices_changed_before_start(),
            "Selected devices changed before recording started. Start again to confirm the inputs.",
        ),
        (
            tr::dialog::capture::shortcut_conflict(),
            "Ctrl+Shift+F9 is assigned to another Cap action. Change that shortcut before recording.",
        ),
        (
            tr::dialog::capture::shortcut_description(),
            "Start or stop this Cap recording",
        ),
        (
            tr::dialog::capture::tray_stop_hint(),
            "Activate the Cap Stop tray icon to start. Activate the same icon again to stop. Recording will not start until you use that control.",
        ),
        (
            tr::dialog::capture::window_unavailable(),
            "The selected window is no longer available. Select it again.",
        ),
        (
            tr::dialog::clipboard::copy_file_failed(),
            "Failed to copy file to clipboard",
        ),
        (
            tr::dialog::clipboard::copy_image_failed(),
            "Failed to copy image to clipboard",
        ),
        (
            tr::dialog::clipboard::not_a_file(),
            "Only files can be copied to the clipboard",
        ),
        (
            tr::dialog::clipboard::unavailable(),
            "Clipboard unavailable",
        ),
        (tr::dialog::file::audio_filter(), "Audio"),
        (
            tr::dialog::file::busy(),
            "A file dialog is already open. Finish or cancel it before trying again.",
        ),
        (tr::dialog::file::export_filter(), "Export"),
        (tr::dialog::file::images_filter(), "Images"),
        (
            tr::dialog::file::unavailable_title(),
            "File dialog unavailable",
        ),
        (
            tr::dialog::file::unconfirmed(),
            "Cap could not confirm that the file dialog closed. Close any remaining file dialog and restart Cap before trying again.",
        ),
        (
            tr::dialog::storage::stopped_kept(),
            "Recording stopped because storage is low. Your recording files were kept. Free up space, then recover the recording below.",
        ),
        (
            tr::dialog::storage::stopped_saved(),
            "Recording stopped because storage is low. Your recording was saved.",
        ),
        (
            tr::dialog::storage::stopping(),
            "Low storage. Stopping and saving your recording…",
        ),
        (tr::dialog::teleprompter::cue_markers(), "Cue markers"),
        (
            tr::dialog::teleprompter::hidden(),
            "This window is hidden from Cap recordings",
        ),
        (tr::dialog::teleprompter::mirror(), "Mirror text"),
        (
            tr::dialog::teleprompter::paused(),
            "Scrolling paused with recording",
        ),
        (
            tr::dialog::teleprompter::placeholder(),
            "Paste or type your script…",
        ),
        (tr::auth::sign_in_failed(), "Sign in failed"),
        (tr::import::error_title(), "Import Error"),
        (tr::import::unsupported(), "Unsupported media file."),
        (tr::import::filter::image(), "Image Files"),
        (tr::import::filter::media(), "Media Files"),
        (tr::import::filter::video(), "Video Files"),
        (tr::import::progress::analyzing(), "Analyzing video file..."),
        (tr::import::progress::complete(), "Import complete!"),
        (tr::import::progress::image(), "Importing image..."),
        (
            tr::import::progress::metadata(),
            "Creating project metadata...",
        ),
        (tr::import::progress::starting(), "Starting conversion..."),
        (tr::upload::status::failed(), "Upload needs attention"),
        (tr::upload::status::paused(), "Upload paused"),
        (tr::upload::status::prepared(), "Upload prepared"),
        (tr::upload::status::processing(), "Processing upload"),
        (tr::upload::status::retrying(), "Upload will retry"),
        (tr::upload::status::sign_in(), "Sign in to retry upload"),
        (tr::upload::status::uploaded(), "Uploaded"),
        (tr::upload::status::uploading(), "Uploading"),
        (tr::overlay::mode_title(), "Change recording mode"),
        (
            tr::overlay::mode_body(),
            "Instant gives you a link to share the moment you stop. Studio records in full quality for editing.",
        ),
        (tr::overlay::countdown_title(), "Recording countdown"),
        (
            tr::overlay::countdown_body(),
            "Wait a few seconds after you press Start before recording begins.",
        ),
        (tr::overlay::area::more_ratios_title(), "More aspect ratios"),
        (
            tr::overlay::area::more_ratios_body(),
            "Lock the area to a ratio such as 4:3, 9:16 or 21:9.",
        ),
        (tr::overlay::area::reset_title(), "Reset selection"),
        (
            tr::overlay::area::reset_body(),
            "Clear the area so you can draw a new one.",
        ),
        (tr::overlay::area::fill_title(), "Fill display"),
        (
            tr::overlay::area::fill_body(),
            "Grow the area to cover the display, keeping its ratio.",
        ),
        (
            tr::overlay::area::fit_window_hint(),
            "Or click a window to fit the area to it",
        ),
        (tr::overlay::area::drag_to_move(), "Drag to move"),
        (tr::overlay::area::locked(), "Locked"),
        (tr::overlay::area::lock_title(), "Lock area"),
        (
            tr::overlay::area::lock_body(),
            "Keep this area for next time, and stop a stray drag from changing it.",
        ),
        (
            tr::overlay::area::lock_needs_area(),
            "Draw an area first, then lock it.",
        ),
        (tr::overlay::area::unlock_title(), "Unlock area"),
        (
            tr::overlay::area::unlock_body(),
            "Let the area be moved, resized or drawn again.",
        ),
        (tr::overlay::area::locked_title(), "Area locked"),
        (
            tr::overlay::area::locked_body(),
            "Click to unlock it, so it can be moved, resized or drawn again.",
        ),
        (tr::overlay::window::size_title(), "Change window size"),
        (
            tr::overlay::window::size_body(),
            "Resize the window to a ratio or an exact size before you record.",
        ),
        (
            tr::overlay::window::size_needs_accessibility_title(),
            "Resizing needs Accessibility",
        ),
        (
            tr::overlay::window::size_needs_accessibility_body(),
            "Turn on Accessibility for Cap in System Settings to resize other apps' windows.",
        ),
        (
            tr::overlay::window::size_unavailable_title(),
            "Resizing isn't available",
        ),
        (
            tr::overlay::window::size_unavailable_body(),
            "Wayland doesn't let apps resize other apps' windows.",
        ),
        (tr::overlay::window::focus_title(), "Focus mode"),
        (
            tr::overlay::window::focus_on(),
            "Recording only this window",
        ),
        (tr::overlay::window::focus_off(), "Record only this window"),
        (tr::overlay::window::focus_enable(), "Enable Focus mode"),
        (tr::overlay::window::focus_disable(), "Turn off Focus mode"),
        (
            tr::overlay::window::focus_body(),
            "Only what's inside this window is recorded. Other windows, even ones on top of it, and the rest of your screen stay out of the video.",
        ),
        (
            tr::overlay::window::focus_body_instant_camera(),
            "With a camera, Instant still records the screen region so the camera stays in the video.",
        ),
        (tr::overlay::window::center_title(), "Center on screen"),
        (
            tr::overlay::window::center_description(),
            "Move the window to the middle when you pick it",
        ),
        (tr::overlay::area::draw(), "Draw an area"),
        (tr::overlay::area::free_ratio(), "Free"),
        (
            tr::overlay::area::hint(),
            "Click and drag to select an area",
        ),
        (
            tr::overlay::camera_only::description(),
            "Record using only your camera and microphone",
        ),
        (
            tr::overlay::camera_only::select_camera(),
            "Please select a camera",
        ),
        (tr::overlay::device::camera_allow(), "Allow camera access…"),
        (
            tr::overlay::device::camera_turn_on(),
            "Turn on camera access in Settings…",
        ),
        (
            tr::overlay::device::microphone_allow(),
            "Allow microphone access…",
        ),
        (
            tr::overlay::device::microphone_turn_on(),
            "Turn on microphone access in Settings…",
        ),
        (
            tr::overlay::start::instant(),
            "Instant Mode — Record shareable link",
        ),
        (
            tr::overlay::start::instant_sign_in(),
            "Instant Mode — Sign in to record instantly",
        ),
        (tr::overlay::start::sign_in(), "Sign In To Use"),
        (tr::overlay::start::start_recording(), "Start Recording"),
        (
            tr::overlay::start::studio(),
            "Studio Mode — Record and edit locally",
        ),
        (tr::overlay::start::take_screenshot(), "Take Screenshot"),
        (
            tr::dialog::mode_select::instant(),
            "Share instantly with a link. Uploads as you record.",
        ),
        (
            tr::dialog::mode_select::screenshot(),
            "Capture and annotate screenshots instantly.",
        ),
        (
            tr::dialog::mode_select::studio(),
            "Highest quality local recording for editing later.",
        ),
        (
            tr::dialog::mode_select::subtitle(),
            "Select how you want to capture your screen",
        ),
        (tr::dialog::mode_select::title(), "Choose Recording Mode"),
        (
            tr::permission::onboarding::open_settings_again(),
            "Open System Settings again",
        ),
        (tr::permission::onboarding::skip(), "Skip for now"),
        (
            tr::permission::onboarding::switch_on_title(),
            "Switch Cap on in System Settings",
        ),
        (
            tr::permission::onboarding::accessibility::allow(),
            "Allow accessibility",
        ),
        (
            tr::permission::onboarding::accessibility::body(),
            "Accessibility lets Cap see your clicks and cursor, on this Mac only, so auto zoom knows where to look.",
        ),
        (
            tr::permission::onboarding::accessibility::done_body(),
            "Auto zoom can follow your clicks.",
        ),
        (
            tr::permission::onboarding::accessibility::done_title(),
            "Accessibility is on",
        ),
        (
            tr::permission::onboarding::accessibility::title(),
            "Let Cap follow your cursor",
        ),
        (
            tr::permission::onboarding::all_set::body(),
            "Cap has everything it needs. Next, a quick look at what it can do.",
        ),
        (
            tr::permission::onboarding::all_set::regained(),
            "Thanks. Cap can record again.",
        ),
        (
            tr::permission::onboarding::all_set::title(),
            "You're all set",
        ),
        (tr::permission::onboarding::camera::allow(), "Allow camera"),
        (
            tr::permission::onboarding::camera::body(),
            "Show yourself in a corner of your recordings. Skip it if you don't need it.",
        ),
        (
            tr::permission::onboarding::camera::done_body(),
            "You can add your camera to any recording.",
        ),
        (
            tr::permission::onboarding::camera::done_title(),
            "Camera is on",
        ),
        (
            tr::permission::onboarding::camera::title(),
            "Let Cap see you",
        ),
        (
            tr::permission::onboarding::checklist::lede(),
            "macOS asks you to OK a few things first. It only takes a minute.",
        ),
        (
            tr::permission::onboarding::checklist::regained_lede(),
            "Something was switched off in System Settings. Turn it back on to keep recording.",
        ),
        (
            tr::permission::onboarding::checklist::regained_title(),
            "Cap needs a permission back",
        ),
        (
            tr::permission::onboarding::checklist::title(),
            "Let's get Cap ready",
        ),
        (
            tr::permission::onboarding::hint::drag_into_list(),
            "Drag Cap from the panel under System Settings into the list. Already listed? Just switch it on.",
        ),
        (
            tr::permission::onboarding::hint::find_in_list(),
            "Find Cap in the list and switch it on. If macOS asked first, choose Open System Settings.",
        ),
        (
            tr::permission::onboarding::hint::no_prompt(),
            "No prompt showed up? Switch Cap on in System Settings.",
        ),
        (
            tr::permission::onboarding::hint::open_settings(),
            "Open System Settings, find Cap in the list and switch it on.",
        ),
        (
            tr::permission::onboarding::hint::turned_off(),
            "It was turned off earlier, so switch Cap on in System Settings. Or skip it for now.",
        ),
        (
            tr::permission::onboarding::microphone::allow(),
            "Allow microphone",
        ),
        (
            tr::permission::onboarding::microphone::body(),
            "Add your voice to your recordings. You can skip this and turn it on later.",
        ),
        (
            tr::permission::onboarding::microphone::done_body(),
            "Your voice can be in your recordings.",
        ),
        (
            tr::permission::onboarding::microphone::done_title(),
            "Microphone is on",
        ),
        (
            tr::permission::onboarding::microphone::title(),
            "Let Cap hear you",
        ),
        (
            tr::permission::onboarding::relaunch::body(),
            "macOS turns on screen recording once Cap restarts. You'll pick up right here.",
        ),
        (tr::permission::onboarding::relaunch::button(), "Relaunch"),
        (
            tr::permission::onboarding::relaunch::hint(),
            "Switched on but still waiting? Restart Cap to apply it.",
        ),
        (
            tr::permission::onboarding::relaunch::later(),
            "macOS applies it after Cap restarts. You can do that once you're done here.",
        ),
        (
            tr::permission::onboarding::relaunch::title(),
            "One restart and you're set",
        ),
        (
            tr::permission::onboarding::screen::allow(),
            "Allow screen recording",
        ),
        (
            tr::permission::onboarding::screen::body(),
            "Screen Recording lets Cap capture your displays, windows and system audio.",
        ),
        (
            tr::permission::onboarding::screen::done_body(),
            "Cap can capture your screen.",
        ),
        (
            tr::permission::onboarding::screen::done_title(),
            "Screen recording is on",
        ),
        (
            tr::permission::onboarding::screen::title(),
            "Let Cap see your screen",
        ),
        (tr::permission::onboarding::status::allowed(), "Allowed"),
        (
            tr::permission::onboarding::status::off(),
            "Off in System Settings",
        ),
        (tr::permission::onboarding::status::optional(), "Optional"),
        (tr::permission::onboarding::status::required(), "Required"),
        (
            tr::permission::onboarding::status::skipped(),
            "Skipped for now",
        ),
        (
            tr::permission::onboarding::waiting::prompt(),
            "Choose Allow in the macOS prompt",
        ),
        (
            tr::permission::onboarding::waiting::system_settings(),
            "Waiting for System Settings",
        ),
        (
            tr::permission::guide::accessibility_body(),
            "Drop it on the Accessibility list above, then make sure its switch is on.",
        ),
        (
            tr::permission::guide::screen_body(),
            "Drop it on the Screen & System Audio Recording list above, then make sure its switch is on.",
        ),
        (tr::permission::guide::title(), "Drag Cap into the list"),
        (tr::permission::name::accessibility(), "Accessibility"),
        (tr::permission::name::camera(), "Camera"),
        (tr::permission::name::microphone(), "Microphone"),
        (tr::permission::name::screen_recording(), "Screen Recording"),
        (
            tr::screenshot_editor::loading_preview(),
            "Loading preview...",
        ),
        (tr::screenshot_editor::zoom_in(), "Zoom In"),
        (tr::screenshot_editor::zoom_out(), "Zoom Out"),
        (tr::screenshot_editor::annotation::default_text(), "Text"),
        (tr::screenshot_editor::annotation::done(), "Done"),
        (tr::screenshot_editor::annotation::fill(), "Fill"),
        (tr::screenshot_editor::annotation::intensity(), "Intensity"),
        (tr::screenshot_editor::annotation::mask_style(), "Style"),
        (tr::screenshot_editor::annotation::pixelate(), "Pixelate"),
        (tr::screenshot_editor::annotation::stroke(), "Stroke"),
        (
            tr::screenshot_editor::annotation::transparent(),
            "Transparent",
        ),
        (tr::screenshot_editor::aspect::auto(), "Auto"),
        (tr::screenshot_editor::aspect::classic(), "Classic ⋅4:3"),
        (tr::screenshot_editor::aspect::square(), "Square ⋅1:1"),
        (tr::screenshot_editor::aspect::tall(), "Tall ⋅3:4"),
        (tr::screenshot_editor::aspect::vertical(), "Vertical ⋅9:16"),
        (tr::screenshot_editor::aspect::wide(), "Wide ⋅16:9"),
        (
            tr::screenshot_editor::background::animated_gradient(),
            "Animated Gradient is rendered as a still image for screenshots. Choose another background to replace it.",
        ),
        (
            tr::screenshot_editor::background::blur_title(),
            "Background Blur",
        ),
        (
            tr::screenshot_editor::background::choose_image(),
            "Click to select or drag and drop image",
        ),
        (tr::screenshot_editor::background::color(), "Color"),
        (tr::screenshot_editor::background::gradient(), "Gradient"),
        (tr::screenshot_editor::background::image(), "Image"),
        (tr::screenshot_editor::background::image_files(), "Image"),
        (
            tr::screenshot_editor::background::image_title(),
            "Background Image",
        ),
        (tr::screenshot_editor::background::wallpaper(), "Wallpaper"),
        (tr::screenshot_editor::corner::rounded(), "Rounded"),
        (tr::screenshot_editor::corner::squircle(), "Squircle"),
        (tr::screenshot_editor::corner::style(), "CORNER STYLE"),
        (tr::screenshot_editor::crop::full(), "Full"),
        (
            tr::screenshot_editor::crop::loading_frame(),
            "Loading frame…",
        ),
        (tr::screenshot_editor::crop::position(), "Position"),
        (
            tr::screenshot_editor::error::not_screenshot(),
            "Not a screenshot bundle",
        ),
        (
            tr::screenshot_editor::error::renderer_not_running(),
            "The screenshot renderer is not running",
        ),
        (
            tr::screenshot_editor::error::renderer_stopped(),
            "The renderer stopped before the export finished",
        ),
        (
            tr::screenshot_editor::error::sign_in_to_share(),
            "Sign in to Cap in your browser, then share again",
        ),
        (
            tr::screenshot_editor::error::upgrade_required(),
            "This feature requires an upgraded plan",
        ),
        (
            tr::screenshot_editor::header::aspect_ratio(),
            "Aspect Ratio",
        ),
        (tr::screenshot_editor::header::copy(), "Copy to Clipboard"),
        (tr::screenshot_editor::header::crop_image(), "Crop Image"),
        (
            tr::screenshot_editor::header::more_actions(),
            "More Actions",
        ),
        (tr::screenshot_editor::layers::empty(), "No layers yet"),
        (
            tr::screenshot_editor::layers::empty_hint(),
            "Use the tools above to add annotations",
        ),
        (
            tr::screenshot_editor::layers::reorder_hint(),
            "Drag to reorder • Top = front",
        ),
        (tr::screenshot_editor::layers::title(), "Layers"),
        (tr::screenshot_editor::menu::delete(), "Delete"),
        (tr::screenshot_editor::menu::open_folder(), "Open Folder"),
        (
            tr::screenshot_editor::share::create_link(),
            "Create shareable link",
        ),
        (
            tr::screenshot_editor::share::preparing(),
            "Preparing upload",
        ),
        (
            tr::screenshot_editor::share::rendering(),
            "Rendering screenshot",
        ),
        (
            tr::screenshot_editor::share::uploading(),
            "Uploading screenshot",
        ),
        (
            tr::screenshot_editor::style::advanced_shadow(),
            "Advanced shadow settings",
        ),
        (tr::screenshot_editor::style::background(), "Background"),
        (tr::screenshot_editor::style::blur(), "Blur"),
        (tr::screenshot_editor::style::border(), "Border"),
        (tr::screenshot_editor::style::color(), "Color"),
        (
            tr::screenshot_editor::style::corner_rounding(),
            "Corner Rounding",
        ),
        (tr::screenshot_editor::style::opacity(), "Opacity"),
        (tr::screenshot_editor::style::padding(), "Padding"),
        (tr::screenshot_editor::style::rounding(), "Rounding"),
        (tr::screenshot_editor::style::shadow(), "Shadow"),
        (tr::screenshot_editor::style::size_label(), "Size"),
        (tr::screenshot_editor::style::width(), "Width"),
        (
            tr::screenshot_editor::toast::copied(),
            "Screenshot copied to clipboard!",
        ),
        (
            tr::screenshot_editor::toast::link_copied(),
            "Share link copied to clipboard",
        ),
        (tr::screenshot_editor::toast::saved(), "Screenshot saved!"),
        (tr::screenshot_editor::tool::arrow(), "Arrow"),
        (tr::screenshot_editor::tool::circle(), "Circle"),
        (tr::screenshot_editor::tool::draw(), "Draw"),
        (tr::screenshot_editor::tool::mask(), "Mask"),
        (tr::screenshot_editor::tool::rectangle(), "Rectangle"),
        (tr::screenshot_editor::tool::select(), "Select"),
        (tr::screenshot_editor::tool::text_label(), "Text"),
        (tr::transcription::download::complete(), "Download complete"),
        (
            tr::transcription::download::preparing(),
            "Preparing model download",
        ),
        (
            tr::transcription::error::intel_mac(),
            "Parakeet models are not available on Intel Macs. Use a Whisper model instead",
        ),
        (
            tr::transcription::error::model_load(),
            "Failed to load the caption model. Try downloading it again",
        ),
        (
            tr::transcription::error::model_missing(),
            "Caption model not found. Please download it first",
        ),
        (
            tr::transcription::error::no_audio(),
            "No audio found in the video file",
        ),
        (
            tr::transcription::error::unsupported_language(),
            "The Recommended and High Accuracy models only transcribe English and 24 other European languages. Download the Small or Medium model to caption this language",
        ),
        (tr::dialog::quit::still_open(), "Cap is still open"),
        (
            tr::dialog::quit::pending(),
            "Quit canceled because recording shutdown is still pending. Cap will stay open. Use Stop once available, then try Quit again.",
        ),
        (
            tr::dialog::quit::unconfirmed(),
            "Quit canceled because recording shutdown could not be confirmed. Cap will stay open. Use Stop, then try Quit again.",
        ),
        (tr::dialog::update::title(), "Update Cap"),
        (tr::dialog::update::busy_title(), "Cap is busy"),
        (
            tr::dialog::update::busy(),
            "Finish your recording, export, upload, import, or transcription task before updating Cap.",
        ),
        (tr::dialog::update::no_update_title(), "No Update Available"),
        (
            tr::dialog::update::no_update(),
            "You're already using the latest version of Cap.",
        ),
        (tr::dialog::update::download(), "Download"),
        (tr::dialog::update::not_now(), "Not Now"),
        (tr::dialog::update::restart_now(), "Restart Now"),
        (tr::dialog::update::later(), "Later"),
        (
            tr::dialog::update::package_not_installed(),
            "The package wasn't installed. Approve the system prompt, or install it from Cap.so/download.",
        ),
    ];
    for (translated, literal) in pairs {
        assert_eq!(translated, literal);
    }

    let plain_keys = KEYS
        .iter()
        .filter(|key| is_dialogs_surface_key(key))
        .count()
        - FORMATTED.len();
    assert_eq!(
        pairs.len(),
        plain_keys,
        "every plain key has a literal above"
    );
    for key in FORMATTED {
        assert!(KEYS.contains(key), "{key}");
    }
}

fn old_stage_label(stage: &str, mode: Option<&str>) -> String {
    let leg = match mode {
        Some("studio") => " studio",
        Some("instant") => " instant",
        _ => "",
    };
    match stage {
        "collecting" => format!("Preparing the{leg} test..."),
        "recording" => format!("Recording the{leg} test..."),
        "pattern-run" => format!("Playing the test pattern{leg}..."),
        "remuxing" => format!("Finalizing the{leg} recording..."),
        "analyzing" => format!("Analyzing the{leg} recording..."),
        "exporting" => format!("Exporting the{leg} recording..."),
        "done" => "Wrapping up the sync test...".to_string(),
        crate::diagnostics::START_STAGE => "Starting the diagnostic...".to_string(),
        crate::diagnostics::COLLECT_STAGE => "Collecting system information...".to_string(),
        crate::diagnostics::CANCEL_STAGE => "Cancelling...".to_string(),
        other => format!("{other}..."),
    }
}

#[test]
fn assembled_dialog_messages_match_the_code_they_replaced() {
    for stage in [
        "collecting",
        "recording",
        "pattern-run",
        "remuxing",
        "analyzing",
        "exporting",
        "done",
        crate::diagnostics::START_STAGE,
        crate::diagnostics::COLLECT_STAGE,
        crate::diagnostics::CANCEL_STAGE,
        "uploading",
    ] {
        for mode in [None, Some("studio"), Some("instant"), Some("both")] {
            assert_eq!(
                crate::diagnostics::stage_label(stage, mode),
                old_stage_label(stage, mode),
                "{stage} {mode:?}"
            );
        }
    }
    for (body, pane) in [
        (tr::permission::guide::accessibility_body(), "Accessibility"),
        (
            tr::permission::guide::screen_body(),
            "Screen & System Audio Recording",
        ),
    ] {
        assert_eq!(
            body,
            format!("Drop it on the {pane} list above, then make sure its switch is on.")
        );
    }
    let message = "Invalid data found when processing input";
    for (media, formatted) in [
        ("video", tr::import::video_failed(message)),
        ("image", tr::import::image_failed(message)),
    ] {
        assert_eq!(formatted, format!("Failed to import {media}: {message}"));
    }
    assert_eq!(
        tr::dialog::capture::shortcut_hint("Ctrl+Shift+F9"),
        "Press and release Ctrl+Shift+F9 to start. Use the same shortcut to stop. This temporary shortcut does not change your settings."
    );
    for permission in crate::permissions::OSPermission::ALL {
        assert_eq!(permission.display_name(), permission.label());
    }
}

#[test]
fn dialog_messages_format_like_the_code_they_replaced() {
    let error = "permission denied (os error 13)";
    let path = std::path::Path::new("/tmp/Cap/report.json");
    let pairs: Vec<(String, String)> = vec![
        (
            tr::diagnostics::error::create_folder(error),
            format!("Failed to create the diagnostics folder: {error}"),
        ),
        (
            tr::diagnostics::error::serialize(error),
            format!("Failed to serialize the report: {error}"),
        ),
        (
            tr::diagnostics::error::start_failed(path.display(), error),
            format!("Failed to start {}: {error}", path.display()),
        ),
        (
            tr::diagnostics::error::upload_logs(error),
            format!("Failed to upload logs: {error}"),
        ),
        (
            tr::diagnostics::error::wait_failed(error),
            format!("The self-test could not be waited on: {error}"),
        ),
        (
            tr::diagnostics::error::write_failed(path.display(), error),
            format!("Failed to write {}: {error}", path.display()),
        ),
        (
            tr::dialog::open_recording_failed(error),
            format!("Opening this recording failed: {error}"),
        ),
        (
            tr::dialog::delete_recording::close_failed(error),
            format!("Could not close the editor: {error}"),
        ),
        (
            tr::dialog::delete_recording::failed(error),
            format!("Recording deletion failed: {error}"),
        ),
        (
            tr::dialog::delete_recording::in_use(error),
            format!(
                "This recording is still in use. Finish or cancel its upload and try again: {error}"
            ),
        ),
        (
            tr::dialog::capture::cleanup_incomplete(error),
            format!("Recording cleanup is incomplete: {error}. A new recording is blocked."),
        ),
        (
            tr::dialog::capture::shortcut_hint("Super+F9"),
            format!(
                "Press and release {} to start. Use the same shortcut to stop. This temporary shortcut does not change your settings.",
                "Super+F9"
            ),
        ),
        (
            tr::dialog::clipboard::copy_file(error),
            format!("Could not copy the file to the clipboard: {error}"),
        ),
        (
            tr::dialog::clipboard::copy_image(error),
            format!("Could not copy the image to the clipboard: {error}"),
        ),
        (
            tr::dialog::clipboard::unavailable_error(error),
            format!("Clipboard unavailable: {error}"),
        ),
        (
            tr::dialog::file::failed(error),
            format!("The file dialog could not complete: {error}"),
        ),
        (
            tr::screenshot_editor::error::encode(error),
            format!("Failed to encode screenshot export: {error}"),
        ),
        (
            tr::screenshot_editor::error::load_meta(error),
            format!("Failed to load screenshot meta: {error}"),
        ),
        (
            tr::screenshot_editor::error::load_metadata(error),
            format!("Failed to load screenshot metadata: {error}"),
        ),
        (
            tr::screenshot_editor::error::no_image(path.display()),
            format!("No PNG found in {}", path.display()),
        ),
        (
            tr::screenshot_editor::error::open_image(error),
            format!("Failed to open image: {error}"),
        ),
        (
            tr::screenshot_editor::error::renderer_failed(error),
            format!("The GPU renderer failed to start: {error}"),
        ),
        (
            tr::screenshot_editor::error::save_project(error),
            format!("Error saving project: {error}"),
        ),
        (
            tr::screenshot_editor::error::serialize(error),
            format!("Failed to serialize screenshot config: {error}"),
        ),
        (
            tr::screenshot_editor::error::upload_task(error),
            format!("The upload task failed: {error}"),
        ),
        (
            tr::transcription::download::failed(error),
            format!("Download failed: {error}"),
        ),
    ];
    for (translated, literal) in &pairs {
        assert_eq!(translated, literal);
    }

    for status in ["exit status: 1", "signal: 9 (SIGKILL)"] {
        assert_eq!(
            tr::diagnostics::error::exited(status),
            format!("The self-test exited with {status}")
        );
    }
    for status in ["500 Internal Server Error", "413 Payload Too Large"] {
        assert_eq!(
            tr::diagnostics::error::upload_status(status),
            format!("Upload failed with status: {status}")
        );
    }
    for (width, height) in [(16_385_u32, 900_u32), (20_000, 20_000)] {
        assert_eq!(
            tr::screenshot_editor::error::too_large(width, height),
            format!("Image dimensions exceed maximum: {width}x{height}")
        );
    }
    for progress in [0.0_f64, 0.426, 99.6, 100.0] {
        assert_eq!(
            tr::transcription::download::progress(format!("{progress:.0}")),
            format!("Downloading model: {progress:.0}%")
        );
        let filename = "ggml-small.bin";
        assert_eq!(
            tr::transcription::download::file_progress(filename, format!("{progress:.0}")),
            format!("Downloading {filename}: {progress:.0}%")
        );
    }
    for progress in [0.0_f64, 0.5, 0.999, 1.0] {
        assert_eq!(
            tr::import::progress::converting((progress * 100.0) as u32),
            format!("Converting video... {}%", (progress * 100.0) as u32)
        );
    }
    for id in [1_u32, 69_733_632] {
        assert_eq!(tr::overlay::display_fallback(id), format!("Display {}", id));
    }
    for min in [150_f64, 200.] {
        assert_eq!(
            tr::overlay::area::minimum_size(min as u32, min as u32),
            format!("Minimum size is {} x {}", min as u32, min as u32)
        );
    }
    for (width, height) in [(12.4_f64, 80.6_f64), (100., 3.)] {
        assert_eq!(
            tr::overlay::area::too_small(width.round(), height.round()),
            format!("{} x {} is too small", width.round(), height.round())
        );
    }
}

#[test]
fn update_and_quit_messages_format_like_the_code_they_replaced() {
    assert_eq!(
        tr::dialog::teleprompter::words_per_minute(150),
        format!("{} wpm", 150)
    );
    let error = "connection reset by peer";
    let version = semver::Version::new(0, 6, 2);
    let pairs: Vec<(String, String)> = vec![
        (
            tr::dialog::quit::canceled(error),
            format!(
                "Quit canceled: {error}. Cap will stay open so you can finish or recover the recording."
            ),
        ),
        (
            tr::dialog::update::already_getting(&version),
            format!("Cap is already getting version {version} ready."),
        ),
        (
            tr::dialog::update::available(&version),
            format!(
                "Version {version} of Cap is available. Cap will download it in the background and let you know when it's ready to install."
            ),
        ),
        (
            tr::dialog::update::check_failed(error),
            format!("Couldn't check for updates: {error}"),
        ),
        (
            tr::dialog::update::download_failed(&version, error),
            format!("Couldn't download version {version}: {error}"),
        ),
        (
            tr::dialog::update::install_failed(&version, error),
            format!("Couldn't install version {version}: {error}"),
        ),
        (
            tr::dialog::update::ready(&version),
            format!("Cap {version} is ready. Restart Cap to finish updating."),
        ),
        (
            tr::dialog::update::failed(error),
            format!("{error}\n\nYou can always download the latest version from Cap.so/download."),
        ),
    ];
    for (translated, literal) in pairs {
        assert_eq!(translated, literal);
    }
}
