use super::*;

pub(super) fn is_editor_shell_surface_key(key: &str) -> bool {
    [
        "editor.canvas.",
        "editor.clips.",
        "editor.export.",
        "editor.modal.",
        "editor.preparing.",
        "editor.tabs.",
        "editor.timeline.",
        "editor.window.",
        "ui.",
    ]
    .iter()
    .any(|prefix| key.starts_with(prefix))
}

const FORMATTED: &[&str] = &[
    "editor.window.clip_menu.transition_seconds",
    "editor.clips.append_error",
    "editor.clips.clip",
    "editor.clips.error.cannot_decode",
    "editor.clips.error.in_use",
    "editor.clips.error.missing_video",
    "editor.clips.error.source_failed",
    "editor.clips.error.unsupported_video",
    "editor.clips.import_error",
    "editor.clips.prepare_controls_failed",
    "editor.clips.save_before_recording_failed",
    "editor.clips.split",
    "editor.export.estimate.gigabytes",
    "editor.export.estimate.gigabytes_range",
    "editor.export.estimate.hours",
    "editor.export.estimate.hours_range",
    "editor.export.estimate.megabytes",
    "editor.export.estimate.megabytes_range",
    "editor.export.estimate.minutes",
    "editor.export.estimate.minutes_range",
    "editor.export.estimate.seconds",
    "editor.export.estimate.seconds_range",
    "editor.export.fps",
    "editor.export.frames",
    "editor.export.stats.output_value",
    "editor.tabs.captions.download",
    "editor.tabs.captions.downloading",
    "editor.tabs.captions.generate_failed",
    "editor.tabs.captions.model_downloaded",
    "editor.tabs.keyboard.load_failed",
    "editor.tabs.sync.clip",
    "editor.timeline.add_shot_with_look",
    "editor.timeline.segment.numbered_clip",
    "editor.window.audio_import.copy_failed",
    "editor.window.audio_import.directory_failed",
    "editor.window.audio_import.not_found",
    "editor.window.audio_import.unsupported",
    "editor.window.busy.save_before_delete_failed",
    "editor.window.frame.style_only",
    "editor.window.frame.style_only_override",
    "editor.window.open.media_failed",
    "editor.window.open.meta_failed",
    "editor.window.open.not_found",
    "editor.window.presets.delete_confirm",
    "editor.window.save_failed",
    "editor.window.text_menu.segments",
    "editor.window.title.not_saved_message",
    "editor.window.title.read_failed",
    "editor.window.title.save_failed",
    "ui.selection.audio",
    "ui.selection.caption",
    "ui.selection.image",
    "ui.selection.keyboard",
    "ui.selection.mask",
    "ui.selection.scene",
    "ui.selection.segments",
    "ui.selection.style",
    "ui.selection.text_segments",
    "ui.selection.three_d",
    "ui.selection.zoom",
    "ui.selection.zoom_all",
    "ui.selection.zoom_some",
];

#[test]
fn editor_shell_surfaces_match_the_literals_they_replaced() {
    let pairs: &[(&str, &str)] = &[
        (tr::editor::canvas::camera(), "Camera"),
        (
            tr::editor::canvas::camera_follows_zoom(),
            "Camera size follows the zoom — drag to move",
        ),
        (tr::editor::canvas::edit_zoom(), "Edit zoom"),
        (tr::editor::canvas::image(), "Image"),
        (tr::editor::canvas::mask(), "Mask"),
        (tr::editor::canvas::screen(), "Screen"),
        (
            tr::editor::canvas::screen_locked(),
            "Screen is locked while a zoom is active",
        ),
        (tr::editor::canvas::text_item(), "Text"),
        (tr::editor::clips::append_error_title(), "Recording Error"),
        (tr::editor::clips::back(), "Back to editor"),
        (tr::editor::clips::cap_filter(), "Cap Recording"),
        (
            tr::editor::clips::empty_description(),
            "Record or import a clip and it will show up here.",
        ),
        (tr::editor::clips::empty_title(), "No clips yet"),
        (tr::editor::clips::error::cancelled(), "Import cancelled"),
        (
            tr::editor::clips::error::instant_source(),
            "Instant recordings can't be imported into a project yet",
        ),
        (
            tr::editor::clips::error::instant_target(),
            "Instant mode recordings cannot be edited",
        ),
        (
            tr::editor::clips::error::into_itself(),
            "Cannot import a recording into itself",
        ),
        (
            tr::editor::clips::error::no_duration(),
            "Imported video has no valid duration",
        ),
        (
            tr::editor::clips::error::not_a_project(),
            "Select a Cap project folder",
        ),
        (
            tr::editor::clips::error::source_empty(),
            "Source Cap project has no recording segments",
        ),
        (
            tr::editor::clips::error::source_recording(),
            "Source Cap project is still recording",
        ),
        (
            tr::editor::clips::error::source_unimportable(),
            "Source Cap project has no importable recording segments",
        ),
        (
            tr::editor::clips::error::unfinished_target(),
            "Finish or recover this recording before importing a clip",
        ),
        (tr::editor::clips::import(), "Import"),
        (tr::editor::clips::import_error_title(), "Import Error"),
        (tr::editor::clips::import_existing(), "Existing recording"),
        (tr::editor::clips::import_mp4(), "MP4 Video…"),
        (tr::editor::clips::importing(), "Importing…"),
        (tr::editor::clips::mp4_filter(), "MP4 Video"),
        (tr::editor::clips::record_new(), "Record a new clip"),
        (tr::editor::clips::title(), "Clips"),
        (
            tr::editor::export::advanced::bits_per_pixel(),
            "Bits per pixel",
        ),
        (
            tr::editor::export::advanced::cursor_only(),
            "Export cursor only",
        ),
        (
            tr::editor::export::advanced::cursor_only_description(),
            "Keeps the same cursor motion and clicks on a transparent background",
        ),
        (
            tr::editor::export::advanced::custom_bitrate(),
            "Using a custom bitrate",
        ),
        (
            tr::editor::export::advanced::force_ffmpeg(),
            "Force FFmpeg decoder",
        ),
        (
            tr::editor::export::advanced::force_ffmpeg_description(),
            "Skip hardware decoder (auto-fallback enabled)",
        ),
        (tr::editor::export::advanced::title(), "Advanced"),
        (
            tr::editor::export::advanced::transparent_mov(),
            "Exports as a transparent MOV. Files are large and best for compositing or editing.",
        ),
        (tr::editor::export::back(), "Back to editor"),
        (tr::editor::export::cta::cancel_sign_in(), "Cancel Sign In"),
        (tr::editor::export::cta::clipboard(), "Export to Clipboard"),
        (
            tr::editor::export::cta::create_link(),
            "Create shareable link",
        ),
        (tr::editor::export::cta::file(), "Export to File"),
        (tr::editor::export::cta::reupload(), "Reupload to same link"),
        (tr::editor::export::cta::sign_in(), "Sign in to share"),
        (tr::editor::export::destination::clipboard(), "Clipboard"),
        (tr::editor::export::destination::file(), "File"),
        (tr::editor::export::destination::link(), "Shareable Link"),
        (tr::editor::export::done::copy_link(), "Copy link"),
        (
            tr::editor::export::done::instant_hint(),
            "Use Instant Mode for your next recording if you want a link the moment you stop.",
        ),
        (tr::editor::export::done::link_copied(), "Link copied"),
        (tr::editor::export::done::open_file(), "Open File"),
        (tr::editor::export::done::open_link(), "Open link"),
        (tr::editor::export::done::retry_copy(), "Retry Copy"),
        (
            tr::editor::export::done::reuploaded(),
            "Your latest edit is ready at the same link",
        ),
        (
            tr::editor::export::done::uploaded(),
            "Your Cap has been uploaded successfully",
        ),
        (tr::editor::export::estimate::under_megabyte(), "< 1 MB"),
        (tr::editor::export::estimate::under_second(), "< 1s"),
        (
            tr::editor::export::existing_link_description(),
            "Reupload replaces the video at this link with your latest edit. Everyone with the link will see the updated version.",
        ),
        (
            tr::editor::export::existing_link_title(),
            "Update your existing link",
        ),
        (tr::editor::export::failed(), "Export failed"),
        (
            tr::editor::export::generating_preview(),
            "Generating preview…",
        ),
        (
            tr::editor::export::link_unavailable_cursor(),
            "Cursor-only exports can only be saved to a file or clipboard.",
        ),
        (
            tr::editor::export::link_unavailable_transparent(),
            "Transparent exports can only be saved to a file or clipboard.",
        ),
        (
            tr::editor::export::optimize::description(),
            "Re-encodes with software for much smaller files (slower)",
        ),
        (tr::editor::export::optimize::title(), "Optimize file size"),
        (tr::editor::export::organization(), "Organization"),
        (
            tr::editor::export::phase::clipboard_failed(),
            "Export complete; clipboard copy failed",
        ),
        (tr::editor::export::phase::complete(), "Export complete"),
        (tr::editor::export::phase::copied(), "Copied to clipboard"),
        (
            tr::editor::export::phase::copying_to_clipboard(),
            "Copying to clipboard",
        ),
        (
            tr::editor::export::phase::rendering_cursor(),
            "Rendering cursor track",
        ),
        (tr::editor::export::phase::rendering_gif(), "Rendering GIF"),
        (
            tr::editor::export::phase::rendering_video(),
            "Rendering video",
        ),
        (
            tr::editor::export::phase::reupload_complete(),
            "Reupload complete",
        ),
        (
            tr::editor::export::phase::reuploading(),
            "Reuploading to your link",
        ),
        (
            tr::editor::export::phase::saving_to_file(),
            "Saving to file",
        ),
        (tr::editor::export::phase::starting(), "Preparing export"),
        (
            tr::editor::export::phase::upload_complete(),
            "Upload complete",
        ),
        (
            tr::editor::export::phase::uploading(),
            "Creating shareable link",
        ),
        (tr::editor::export::preview(), "Preview"),
        (
            tr::editor::export::preview_info(),
            "This is a rendered frame from your video. Adjust the settings to see the quality of the final export.",
        ),
        (
            tr::editor::export::preview_unavailable(),
            "Preview unavailable",
        ),
        (tr::editor::export::quality::larger(), "Larger file"),
        (tr::editor::export::quality::maximum(), "Maximum"),
        (tr::editor::export::quality::potato(), "Potato"),
        (tr::editor::export::quality::smaller(), "Smaller file"),
        (tr::editor::export::quality::social(), "Social"),
        (tr::editor::export::quality::web(), "Web"),
        (tr::editor::export::resources::proceed(), "Proceed anyway"),
        (
            tr::editor::export::resources::title(),
            "Check export resources",
        ),
        (tr::editor::export::reupload(), "Reupload"),
        (
            tr::editor::export::reupload_tooltip(),
            "Upload your latest edit to the same link",
        ),
        (
            tr::editor::export::reupload_transparent(),
            "Share links require a background without transparency",
        ),
        (tr::editor::export::section::destination(), "Destination"),
        (tr::editor::export::section::format(), "Format"),
        (tr::editor::export::section::frame_rate(), "Frame rate"),
        (tr::editor::export::section::quality(), "Quality"),
        (tr::editor::export::section::resolution(), "Resolution"),
        (
            tr::editor::export::sign_in_required(),
            "You need to sign in to share recordings",
        ),
        (tr::editor::export::stats::calculating(), "Calculating…"),
        (tr::editor::export::stats::duration(), "Duration"),
        (
            tr::editor::export::stats::estimated_size(),
            "Estimated size",
        ),
        (tr::editor::export::stats::export_time(), "Export time"),
        (tr::editor::export::stats::output(), "Output"),
        (tr::editor::export::stats::refining_size(), "Refining size…"),
        (tr::editor::export::stats::refining_time(), "Refining time…"),
        (tr::editor::export::stats::unavailable(), "Unavailable"),
        (tr::editor::export::task_failed(), "Export task failed"),
        (tr::editor::export::title(), "Export"),
        (
            tr::editor::export::upgrade_message(),
            "This feature requires an upgraded plan",
        ),
        (tr::editor::export::upgrade_title(), "Upgrade required"),
        (
            tr::editor::export::upload_failed(),
            "Failed to upload recording",
        ),
        (tr::editor::modal::cancel_export(), "Cancel export"),
        (
            tr::editor::modal::cancel_export_message(),
            "Are you sure you want to cancel the export?",
        ),
        (tr::editor::modal::cancel_export_title(), "Cancel export?"),
        (tr::editor::modal::keep_exporting(), "Keep exporting"),
        (
            tr::editor::modal::recording_retained(),
            "Recording retained",
        ),
        (tr::editor::tabs::audio::isolation_balanced(), "Balanced"),
        (
            tr::editor::tabs::audio::isolation_balanced_description(),
            "Clearer isolation with natural voice detail.",
        ),
        (tr::editor::tabs::audio::isolation_light(), "Light"),
        (
            tr::editor::tabs::audio::isolation_light_description(),
            "Keep more of your original voice and room sound.",
        ),
        (tr::editor::tabs::audio::isolation_strong(), "Strong"),
        (
            tr::editor::tabs::audio::isolation_strong_description(),
            "More isolation for noisy spaces. May change voice texture.",
        ),
        (tr::editor::tabs::audio::mic_volume(), "Microphone Volume"),
        (tr::editor::tabs::audio::mute(), "Mute Audio"),
        (tr::editor::tabs::audio::stereo::mono_left(), "Mono L"),
        (tr::editor::tabs::audio::stereo::mono_right(), "Mono R"),
        (tr::editor::tabs::audio::stereo::stereo(), "Stereo"),
        (
            tr::editor::tabs::audio::stereo_mode(),
            "Microphone Stereo Mode",
        ),
        (
            tr::editor::tabs::audio::studio_sound_description(),
            "Reduces background noise and balances your voice level.",
        ),
        (
            tr::editor::tabs::audio::studio_sound_save_failed(),
            "Could not save the Studio Sound default",
        ),
        (
            tr::editor::tabs::audio::system_volume(),
            "System Audio Volume",
        ),
        (tr::editor::tabs::audio::title(), "Audio Controls"),
        (
            tr::editor::tabs::audio::use_for_new(),
            "Use for new recordings",
        ),
        (
            tr::editor::tabs::camera::advanced_shadow(),
            "Advanced shadow settings",
        ),
        (tr::editor::tabs::camera::background(), "Background"),
        (tr::editor::tabs::camera::blur::heavy(), "Heavy Blur"),
        (tr::editor::tabs::camera::blur::light(), "Light Blur"),
        (tr::editor::tabs::camera::blur::off(), "Off"),
        (
            tr::editor::tabs::camera::blur::remove(),
            "Remove Background",
        ),
        (tr::editor::tabs::camera::corner_style(), "Corner Style"),
        (
            tr::editor::tabs::camera::custom_position(),
            "Custom position (dragged on canvas)",
        ),
        (tr::editor::tabs::camera::hide(), "Hide Camera"),
        (
            tr::editor::tabs::camera::keep_size_during_zoom(),
            "Keep original size during zoom",
        ),
        (tr::editor::tabs::camera::mirror(), "Mirror Camera"),
        (tr::editor::tabs::camera::position(), "Position"),
        (tr::editor::tabs::camera::reset(), "Reset"),
        (
            tr::editor::tabs::camera::rounded_corners(),
            "Rounded Corners",
        ),
        (tr::editor::tabs::camera::shadow(), "Shadow"),
        (tr::editor::tabs::camera::shadow_blur(), "Blur"),
        (tr::editor::tabs::camera::shadow_opacity(), "Opacity"),
        (tr::editor::tabs::camera::shape::source(), "Source"),
        (tr::editor::tabs::camera::shape::square(), "Square"),
        (tr::editor::tabs::camera::shape_label(), "Shape"),
        (
            tr::editor::tabs::camera::size_during_zoom(),
            "Size During Zoom",
        ),
        (tr::editor::tabs::camera::size_label(), "Size"),
        (tr::editor::tabs::camera::title(), "Camera"),
        (
            tr::editor::tabs::captions::active_word_highlight(),
            "Active Word Highlight",
        ),
        (tr::editor::tabs::captions::animation::bounce(), "Bounce"),
        (tr::editor::tabs::captions::animation::none(), "None"),
        (tr::editor::tabs::captions::animation::pop(), "Pop"),
        (tr::editor::tabs::captions::animation_section(), "Animation"),
        (
            tr::editor::tabs::captions::animation_style(),
            "Animation Style",
        ),
        (
            tr::editor::tabs::captions::background_color(),
            "Background Color",
        ),
        (
            tr::editor::tabs::captions::background_opacity(),
            "Background Opacity",
        ),
        (
            tr::editor::tabs::captions::background_settings(),
            "Background Settings",
        ),
        (tr::editor::tabs::captions::beta(), "Beta"),
        (tr::editor::tabs::captions::delete(), "Delete"),
        (tr::editor::tabs::captions::deleting(), "Deleting..."),
        (
            tr::editor::tabs::captions::download_note(),
            "One time download to your system. All captions are stored locally.",
        ),
        (tr::editor::tabs::captions::fade_duration(), "Fade Duration"),
        (tr::editor::tabs::captions::font_family(), "Font Family"),
        (tr::editor::tabs::captions::font_settings(), "Font Settings"),
        (tr::editor::tabs::captions::font_weight(), "Font Weight"),
        (tr::editor::tabs::captions::generate(), "Generate Captions"),
        (tr::editor::tabs::captions::generating(), "Generating..."),
        (tr::editor::tabs::captions::highlight::color(), "Color"),
        (tr::editor::tabs::captions::highlight::pill(), "Pill"),
        (
            tr::editor::tabs::captions::highlight_color(),
            "Highlight Color",
        ),
        (
            tr::editor::tabs::captions::highlight_note(),
            "This is the first version of captions in Cap. Active word highlighting may be inaccurate in some situations. We're working on a fix for this and it will be released in upcoming versions.",
        ),
        (
            tr::editor::tabs::captions::highlight_style(),
            "Highlight Style",
        ),
        (
            tr::editor::tabs::captions::horizontal_position(),
            "Horizontal Position",
        ),
        (
            tr::editor::tabs::captions::intel_unavailable(),
            "Parakeet caption models are unavailable on Intel Macs. Whisper models remain available.",
        ),
        (
            tr::editor::tabs::captions::keep_open(),
            "Keep Cap open while the model downloads. Editor reloads will reconnect automatically.",
        ),
        (tr::editor::tabs::captions::language::ar(), "Arabic"),
        (tr::editor::tabs::captions::language::auto(), "Auto Detect"),
        (tr::editor::tabs::captions::language::bn(), "Bengali"),
        (tr::editor::tabs::captions::language::de(), "German"),
        (tr::editor::tabs::captions::language::en(), "English"),
        (tr::editor::tabs::captions::language::es(), "Spanish"),
        (tr::editor::tabs::captions::language::fa(), "Persian"),
        (tr::editor::tabs::captions::language::fr(), "French"),
        (tr::editor::tabs::captions::language::gu(), "Gujarati"),
        (tr::editor::tabs::captions::language::he(), "Hebrew"),
        (tr::editor::tabs::captions::language::hi(), "Hindi"),
        (tr::editor::tabs::captions::language::it(), "Italian"),
        (tr::editor::tabs::captions::language::ja(), "Japanese"),
        (tr::editor::tabs::captions::language::ko(), "Korean"),
        (tr::editor::tabs::captions::language::mr(), "Marathi"),
        (tr::editor::tabs::captions::language::nl(), "Dutch"),
        (tr::editor::tabs::captions::language::pa(), "Punjabi"),
        (tr::editor::tabs::captions::language::pl(), "Polish"),
        (tr::editor::tabs::captions::language::pt(), "Portuguese"),
        (tr::editor::tabs::captions::language::ru(), "Russian"),
        (tr::editor::tabs::captions::language::sk(), "Slovak"),
        (tr::editor::tabs::captions::language::ta(), "Tamil"),
        (tr::editor::tabs::captions::language::te(), "Telugu"),
        (tr::editor::tabs::captions::language::tr(), "Turkish"),
        (tr::editor::tabs::captions::language::ur(), "Urdu"),
        (tr::editor::tabs::captions::language::zh(), "Chinese"),
        (tr::editor::tabs::captions::language_label(), "Language"),
        (
            tr::editor::tabs::captions::model::high_accuracy(),
            "High Accuracy",
        ),
        (
            tr::editor::tabs::captions::model::high_accuracy_description(),
            "Larger download, higher accuracy",
        ),
        (tr::editor::tabs::captions::model::medium(), "Medium"),
        (
            tr::editor::tabs::captions::model::medium_description(),
            "Slower, more accurate",
        ),
        (
            tr::editor::tabs::captions::model::recommended(),
            "Recommended",
        ),
        (
            tr::editor::tabs::captions::model::recommended_description(),
            "Best balance for most recordings",
        ),
        (tr::editor::tabs::captions::model::small(), "Small"),
        (
            tr::editor::tabs::captions::model::small_description(),
            "Smallest download",
        ),
        (tr::editor::tabs::captions::model_label(), "Model"),
        (tr::editor::tabs::captions::position(), "Position"),
        (tr::editor::tabs::captions::preset::classic(), "Classic"),
        (
            tr::editor::tabs::captions::preset::classic_description(),
            "Clean text on a solid rounded background.",
        ),
        (tr::editor::tabs::captions::preset::highlight(), "Highlight"),
        (
            tr::editor::tabs::captions::preset::highlight_description(),
            "Bold caps with a pill behind the active word.",
        ),
        (tr::editor::tabs::captions::preset::karaoke(), "Karaoke"),
        (
            tr::editor::tabs::captions::preset::karaoke_description(),
            "Words light up in sync with speech.",
        ),
        (tr::editor::tabs::captions::preset::minimal(), "Minimal"),
        (
            tr::editor::tabs::captions::preset::minimal_description(),
            "Subtle outlined text with no background.",
        ),
        (tr::editor::tabs::captions::preset::pop(), "Pop"),
        (
            tr::editor::tabs::captions::preset::pop_description(),
            "Playful caps that pop in with a vibrant accent.",
        ),
        (
            tr::editor::tabs::captions::regenerate(),
            "Regenerate Captions",
        ),
        (tr::editor::tabs::captions::size_label(), "Size"),
        (tr::editor::tabs::captions::style(), "Style"),
        (tr::editor::tabs::captions::text_color(), "Text Color"),
        (tr::editor::tabs::captions::title(), "Captions"),
        (tr::editor::tabs::captions::uppercase(), "Uppercase"),
        (
            tr::editor::tabs::captions::vertical_position(),
            "Vertical Position",
        ),
        (tr::editor::tabs::corner::rounded(), "Rounded"),
        (tr::editor::tabs::corner::squircle(), "Squircle"),
        (tr::editor::tabs::cursor::friction(), "Friction"),
        (tr::editor::tabs::cursor::hide_when_idle(), "Hide When Idle"),
        (
            tr::editor::tabs::cursor::inactivity_delay(),
            "Inactivity Delay",
        ),
        (tr::editor::tabs::cursor::mass(), "Mass"),
        (
            tr::editor::tabs::cursor::movement_style(),
            "Cursor Movement Style",
        ),
        (tr::editor::tabs::cursor::show(), "Show cursor"),
        (tr::editor::tabs::cursor::size_label(), "Size"),
        (
            tr::editor::tabs::cursor::smooth_movement(),
            "Smooth Movement",
        ),
        (tr::editor::tabs::cursor::style::fast(), "Fast"),
        (
            tr::editor::tabs::cursor::style::fast_description(),
            "Snappy, close tracking",
        ),
        (tr::editor::tabs::cursor::style::mellow(), "Mellow"),
        (
            tr::editor::tabs::cursor::style::mellow_description(),
            "Balanced, natural movement",
        ),
        (tr::editor::tabs::cursor::style::slow(), "Slow"),
        (
            tr::editor::tabs::cursor::style::slow_description(),
            "Long, drifting movement",
        ),
        (tr::editor::tabs::cursor::style::smooth(), "Smooth"),
        (
            tr::editor::tabs::cursor::style::smooth_description(),
            "Soft, floaty movement",
        ),
        (tr::editor::tabs::cursor::style_label(), "Cursor Style"),
        (
            tr::editor::tabs::cursor::svg_cursors(),
            "High Quality SVG Cursors",
        ),
        (tr::editor::tabs::cursor::tension(), "Tension"),
        (tr::editor::tabs::cursor::tilt(), "Tilt"),
        (tr::editor::tabs::keyboard::animation(), "Animation"),
        (
            tr::editor::tabs::keyboard::background_color(),
            "Background Color",
        ),
        (
            tr::editor::tabs::keyboard::background_opacity(),
            "Background Opacity",
        ),
        (
            tr::editor::tabs::keyboard::background_settings(),
            "Background Settings",
        ),
        (tr::editor::tabs::keyboard::behavior(), "Behavior"),
        (tr::editor::tabs::keyboard::beta(), "Beta"),
        (
            tr::editor::tabs::keyboard::changed_during_generation(),
            "The timeline or keyboard settings changed during generation. Try again.",
        ),
        (
            tr::editor::tabs::keyboard::empty_description(),
            "Click \"Generate Keyboard Segments\" to create segments from recorded keyboard presses.",
        ),
        (
            tr::editor::tabs::keyboard::empty_title(),
            "No keyboard segments yet.",
        ),
        (tr::editor::tabs::keyboard::fade_duration(), "Fade Duration"),
        (tr::editor::tabs::keyboard::font_family(), "Font Family"),
        (tr::editor::tabs::keyboard::font_settings(), "Font Settings"),
        (tr::editor::tabs::keyboard::font_weight(), "Font Weight"),
        (
            tr::editor::tabs::keyboard::generate(),
            "Generate Keyboard Segments",
        ),
        (
            tr::editor::tabs::keyboard::generating(),
            "Generating Keyboard Segments...",
        ),
        (
            tr::editor::tabs::keyboard::grouping_threshold(),
            "Grouping Threshold",
        ),
        (
            tr::editor::tabs::keyboard::linger_duration(),
            "Linger Duration",
        ),
        (
            tr::editor::tabs::keyboard::no_presses(),
            "No recorded keyboard presses were found.",
        ),
        (tr::editor::tabs::keyboard::position(), "Position"),
        (
            tr::editor::tabs::keyboard::regenerate(),
            "Regenerate Keyboard Segments",
        ),
        (
            tr::editor::tabs::keyboard::show_modifiers(),
            "Show Modifiers",
        ),
        (
            tr::editor::tabs::keyboard::show_special_keys(),
            "Show Special Keys",
        ),
        (tr::editor::tabs::keyboard::size_label(), "Size"),
        (tr::editor::tabs::keyboard::text_color(), "Text Color"),
        (
            tr::editor::tabs::keyboard::timeline_unavailable(),
            "The project timeline is unavailable.",
        ),
        (
            tr::editor::tabs::keyboard::timeline_unreadable(),
            "The project timeline could not be read.",
        ),
        (tr::editor::tabs::keyboard::title(), "Show keyboard"),
        (tr::editor::tabs::keyboard::uppercase(), "Uppercase"),
        (tr::editor::tabs::position::bottom_center(), "Bottom Center"),
        (tr::editor::tabs::position::bottom_left(), "Bottom Left"),
        (tr::editor::tabs::position::bottom_right(), "Bottom Right"),
        (tr::editor::tabs::position::manual(), "Manual"),
        (tr::editor::tabs::position::top_center(), "Top Center"),
        (tr::editor::tabs::position::top_left(), "Top Left"),
        (tr::editor::tabs::position::top_right(), "Top Right"),
        (
            tr::editor::tabs::sync::auto_description(),
            "Cap calculated these offsets automatically to keep audio in sync with the video. Adjust them if anything still sounds off.",
        ),
        (tr::editor::tabs::sync::auto_synced(), "Auto-synced"),
        (tr::editor::tabs::sync::camera(), "Camera Offset"),
        (
            tr::editor::tabs::sync::description(),
            "Fine-tune source offsets if audio or camera drifts out of sync with the screen recording.",
        ),
        (tr::editor::tabs::sync::microphone(), "Microphone Offset"),
        (
            tr::editor::tabs::sync::system_audio(),
            "System Audio Offset",
        ),
        (tr::editor::tabs::sync::title(), "Sync"),
        (tr::editor::tabs::weight::bold(), "Bold"),
        (tr::editor::tabs::weight::medium(), "Medium"),
        (tr::editor::tabs::weight::normal(), "Normal"),
        (tr::editor::timeline::add_shot(), "Add shot"),
        (tr::editor::timeline::empty::add_audio(), "Add audio"),
        (tr::editor::timeline::empty::add_scene(), "Add scene"),
        (
            tr::editor::timeline::empty::audio(),
            "Add background music or import your own audio",
        ),
        (tr::editor::timeline::empty::captions(), "No captions"),
        (
            tr::editor::timeline::empty::keyboard(),
            "No keyboard events",
        ),
        (
            tr::editor::timeline::empty::scene(),
            "Switch layouts between your screen and camera",
        ),
        (tr::editor::timeline::paused(), "Paused"),
        (
            tr::editor::timeline::picker::audio(),
            "Add background music or import your own audio.",
        ),
        (
            tr::editor::timeline::picker::caption(),
            "Auto-transcribe your recording into on-screen subtitles.",
        ),
        (
            tr::editor::timeline::picker::clip(),
            "Your recorded screen footage.",
        ),
        (
            tr::editor::timeline::picker::image(),
            "Add an image to your recording.",
        ),
        (
            tr::editor::timeline::picker::keyboard(),
            "Display key presses on screen as you type.",
        ),
        (
            tr::editor::timeline::picker::mask(),
            "Blur or black out private areas of the screen.",
        ),
        (
            tr::editor::timeline::picker::scene(),
            "Switch layouts between your screen and camera.",
        ),
        (
            tr::editor::timeline::picker::scene_unavailable(),
            "Record with a camera to use scenes.",
        ),
        (
            tr::editor::timeline::picker::style(),
            "Change background, camera and cursor settings over time.",
        ),
        (
            tr::editor::timeline::picker::text_overlay(),
            "Add custom text overlays and titles to the canvas.",
        ),
        (
            tr::editor::timeline::picker::three_d(),
            "Tilt the scene in 3D perspective.",
        ),
        (
            tr::editor::timeline::picker::zoom(),
            "Smooth zoom-ins that follow the action.",
        ),
        (
            tr::editor::timeline::remove::audio(),
            "Remove the Audio track.",
        ),
        (
            tr::editor::timeline::remove::captions(),
            "Remove the Captions track.",
        ),
        (
            tr::editor::timeline::remove::clip(),
            "Remove the Clip track.",
        ),
        (
            tr::editor::timeline::remove::image(),
            "Remove the Image track.",
        ),
        (
            tr::editor::timeline::remove::keyboard(),
            "Remove the Keyboard track.",
        ),
        (
            tr::editor::timeline::remove::mask(),
            "Remove the Mask track.",
        ),
        (
            tr::editor::timeline::remove::scene(),
            "Remove the Scene track.",
        ),
        (
            tr::editor::timeline::remove::style(),
            "Remove the Style track.",
        ),
        (
            tr::editor::timeline::remove::text_track(),
            "Remove the Text track.",
        ),
        (
            tr::editor::timeline::remove::three_d(),
            "Remove the 3D track.",
        ),
        (
            tr::editor::timeline::remove::zoom(),
            "Remove the Zoom track.",
        ),
        (tr::editor::timeline::scene::camera_only(), "Camera Only"),
        (tr::editor::timeline::scene::default(), "Default"),
        (tr::editor::timeline::scene::floating(), "Floating"),
        (tr::editor::timeline::scene::hide_camera(), "Hide Camera"),
        (tr::editor::timeline::scene::split_screen(), "Split Screen"),
        (tr::editor::timeline::segment::audio(), "Audio"),
        (
            tr::editor::timeline::segment::automatic_zoom(),
            "Automatic Zoom",
        ),
        (tr::editor::timeline::segment::caption(), "Caption"),
        (tr::editor::timeline::segment::clip(), "Clip"),
        (
            tr::editor::timeline::segment::cursor_hidden(),
            "Cursor hidden",
        ),
        (tr::editor::timeline::segment::highlight(), "Highlight"),
        (tr::editor::timeline::segment::label(), "Label"),
        (tr::editor::timeline::segment::manual_zoom(), "Manual Zoom"),
        (tr::editor::timeline::segment::muted(), "Muted"),
        (tr::editor::timeline::segment::sensitive(), "Sensitive"),
        (tr::editor::timeline::track::audio(), "Audio"),
        (tr::editor::timeline::track::captions(), "Captions"),
        (tr::editor::timeline::track::clip(), "Clip"),
        (tr::editor::timeline::track::image(), "Image"),
        (tr::editor::timeline::track::keyboard(), "Keyboard"),
        (tr::editor::timeline::track::mask(), "Mask"),
        (tr::editor::timeline::track::scene(), "Scene"),
        (tr::editor::timeline::track::style(), "Style"),
        (tr::editor::timeline::track::text_track(), "Text"),
        (tr::editor::timeline::track::video(), "Video"),
        (tr::editor::timeline::track::zoom(), "Zoom"),
        (tr::editor::window::add_track::button(), "Add track"),
        (
            tr::editor::window::add_track::hide_3d(),
            "Hide the 3D track.",
        ),
        (
            tr::editor::window::add_track::hint(),
            "Choose a track to add to your timeline.",
        ),
        (tr::editor::window::aspect::auto(), "Auto"),
        (tr::editor::window::aspect::classic(), "Classic"),
        (tr::editor::window::aspect::classic_ratio(), "Classic ⋅4:3"),
        (tr::editor::window::aspect::square(), "Square"),
        (tr::editor::window::aspect::square_ratio(), "Square ⋅1:1"),
        (tr::editor::window::aspect::tall(), "Tall"),
        (tr::editor::window::aspect::tall_ratio(), "Tall ⋅3:4"),
        (tr::editor::window::aspect::tooltip(), "Aspect Ratio"),
        (tr::editor::window::aspect::vertical(), "Vertical"),
        (
            tr::editor::window::aspect::vertical_ratio(),
            "Vertical ⋅9:16",
        ),
        (tr::editor::window::aspect::wide(), "Wide"),
        (tr::editor::window::aspect::wide_ratio(), "Wide ⋅16:9"),
        (tr::editor::window::audio_filter(), "Audio"),
        (
            tr::editor::window::audio_import::no_extension(),
            "Audio file has no extension",
        ),
        (
            tr::editor::window::audio_segment_changed(),
            "This audio segment changed. Select it and choose a replacement again.",
        ),
        (
            tr::editor::window::busy::clip_import(),
            "Wait for the clip import to finish before closing or deleting this recording.",
        ),
        (
            tr::editor::window::busy::export(),
            "Wait for the export or its cancellation to finish before closing or deleting this recording.",
        ),
        (
            tr::editor::window::busy::opening(),
            "Wait for the recording to finish opening before deleting it.",
        ),
        (tr::editor::window::camera3d_lane::add_shot(), "+ Add shot"),
        (
            tr::editor::window::camera3d_lane::auto_scene(),
            "Auto scene",
        ),
        (
            tr::editor::window::camera3d_lane::how_many(),
            "How many shots?",
        ),
        (
            tr::editor::window::camera3d_lane::prompt(),
            "Add cinematic 3D shots to your recording",
        ),
        (tr::editor::window::clip_menu::audio(), "AUDIO"),
        (tr::editor::window::clip_menu::cursor(), "CURSOR"),
        (tr::editor::window::clip_menu::delete(), "Delete clip"),
        (
            tr::editor::window::clip_menu::delete_only_clip(),
            "Can't delete the only clip",
        ),
        (tr::editor::window::clip_menu::hide_cursor(), "Hide cursor"),
        (
            tr::editor::window::clip_menu::hide_cursor_description(),
            "Fades out while this clip plays",
        ),
        (tr::editor::window::clip_menu::keep_pitch(), "Keep pitch"),
        (tr::editor::window::clip_menu::match_speed(), "Match speed"),
        (
            tr::editor::window::clip_menu::merge_next(),
            "Merge with next clip",
        ),
        (
            tr::editor::window::clip_menu::merge_previous(),
            "Merge with previous clip",
        ),
        (tr::editor::window::clip_menu::mute(), "Mute"),
        (tr::editor::window::clip_menu::mute_clip(), "Mute clip"),
        (
            tr::editor::window::clip_menu::mute_clip_description(),
            "Silence this clip's audio",
        ),
        (tr::editor::window::clip_menu::rename(), "Rename clip"),
        (tr::editor::window::clip_menu::speed(), "SPEED"),
        (tr::editor::window::clip_menu::split(), "Split at playhead"),
        (
            tr::editor::window::clip_menu::split_hint(),
            "Move the playhead into this clip",
        ),
        (tr::editor::window::clip_menu::volume(), "Volume"),
        (tr::editor::window::crop(), "Crop"),
        (tr::editor::window::crop_tooltip(), "Crop Video"),
        (tr::editor::window::frame::add_tooltip(), "Add a frame"),
        (tr::editor::window::frame::browser(), "Browser"),
        (
            tr::editor::window::frame::browser_description(),
            "Browser chrome with address bar",
        ),
        (tr::editor::window::frame::button(), "Frame"),
        (tr::editor::window::frame::dark(), "Dark"),
        (
            tr::editor::window::frame::global(),
            "Global frame · Applies wherever Style inherits background.",
        ),
        (tr::editor::window::frame::heading(), "Frame"),
        (tr::editor::window::frame::light(), "Light"),
        (
            tr::editor::window::frame::macbook_description(),
            "Laptop bezel around the recording",
        ),
        (
            tr::editor::window::frame::macos_description(),
            "Window chrome with traffic lights",
        ),
        (tr::editor::window::frame::none(), "None"),
        (
            tr::editor::window::frame::none_description(),
            "Show the recording as-is",
        ),
        (
            tr::editor::window::frame::style_changed(),
            "This Style changed. Close and reopen Frame.",
        ),
        (tr::editor::window::frame::theme(), "Theme"),
        (tr::editor::window::frame::title(), "Title"),
        (tr::editor::window::frame::url(), "URL"),
        (
            tr::editor::window::frame::window_title_placeholder(),
            "Window title",
        ),
        (
            tr::editor::window::frame::windows_description(),
            "Title bar with window controls",
        ),
        (tr::editor::window::header::captions(), "Captions"),
        (
            tr::editor::window::header::delete_recording(),
            "Delete recording",
        ),
        (tr::editor::window::header::export(), "Export"),
        (
            tr::editor::window::header::open_bundle(),
            "Open recording bundle",
        ),
        (tr::editor::window::header::presets(), "Presets"),
        (
            tr::editor::window::image::changed(),
            "This image changed while choosing a replacement. Select it and try again.",
        ),
        (tr::editor::window::image::filter(), "Images"),
        (
            tr::editor::window::image::recording_unavailable(),
            "The recording is no longer available for this image. Please reopen the project.",
        ),
        (
            tr::editor::window::no_room_for_3d_shot(),
            "No room for another 3D shot",
        ),
        (
            tr::editor::window::open::damaged(),
            "This recording's video tracks could not be opened. The bundle looks damaged.",
        ),
        (
            tr::editor::window::open::failed(),
            "This recording could not be opened",
        ),
        (
            tr::editor::window::open::no_segments(),
            "Recording has no segments. It may need to be recovered first.",
        ),
        (
            tr::editor::window::open::not_studio(),
            "Cannot edit non-studio recordings",
        ),
        (tr::editor::window::presets::apply(), "Apply"),
        (tr::editor::window::presets::create(), "Create"),
        (
            tr::editor::window::presets::create_new(),
            "Create new preset",
        ),
        (tr::editor::window::presets::create_title(), "Create Preset"),
        (tr::editor::window::presets::default(), "Default"),
        (tr::editor::window::presets::default_badge(), "Default"),
        (tr::editor::window::presets::delete(), "Delete"),
        (tr::editor::window::presets::delete_title(), "Delete Preset"),
        (
            tr::editor::window::presets::name_placeholder(),
            "Preset name",
        ),
        (
            tr::editor::window::presets::none_saved(),
            "No saved presets",
        ),
        (tr::editor::window::presets::rename(), "Rename"),
        (tr::editor::window::presets::rename_title(), "Rename Preset"),
        (
            tr::editor::window::presets::save_settings(),
            "Save settings to preset",
        ),
        (tr::editor::window::presets::set_default(), "Set as default"),
        (tr::editor::window::preview::full(), "Full"),
        (tr::editor::window::preview::half(), "Half"),
        (tr::editor::window::preview::label(), "Preview"),
        (tr::editor::window::preview::quarter(), "Quarter"),
        (tr::editor::window::redo(), "Redo"),
        (tr::editor::window::text_menu::copy_style(), "Copy style"),
        (
            tr::editor::window::text_menu::copy_style_first(),
            "Copy a style first",
        ),
        (
            tr::editor::window::text_menu::delete_segment(),
            "Delete text segment",
        ),
        (
            tr::editor::window::text_menu::delete_segments(),
            "Delete text segments",
        ),
        (tr::editor::window::text_menu::paste_style(), "Paste style"),
        (
            tr::editor::window::text_menu::paste_style_all(),
            "Paste style to all selected",
        ),
        (tr::editor::window::text_menu::untitled(), "Text"),
        (tr::editor::window::title::not_saved(), "Title not saved"),
        (tr::editor::window::track::clear_all(), "Clear all"),
        (tr::editor::window::track::delete(), "Delete"),
        (
            tr::editor::window::transport::done_splitting(),
            "Done splitting",
        ),
        (
            tr::editor::window::transport::play_pause(),
            "Play/Pause video",
        ),
        (tr::editor::window::transport::split(), "Split"),
        (
            tr::editor::window::transport::split_tooltip(),
            "Click a segment to split. Esc to finish.",
        ),
        (tr::editor::window::transport::zoom_in(), "Zoom in"),
        (tr::editor::window::transport::zoom_out(), "Zoom out"),
        (tr::editor::window::undo(), "Undo"),
        (tr::editor::window::zoom_lane::generate(), "Generate"),
        (tr::editor::window::zoom_lane::generating(), "Generating…"),
        (
            tr::editor::window::zoom_lane::no_clicks(),
            "No clicks found to zoom into. Drag across the lane to add one.",
        ),
        (
            tr::editor::window::zoom_lane::prompt(),
            "Add zooms automatically",
        ),
        (tr::ui::coming_soon(), "Coming Soon"),
        (tr::ui::selection::delete(), "Delete"),
        (tr::ui::selection::done(), "Done"),
        (tr::editor::export::turbo::title(), "Turbo export"),
        (
            tr::editor::export::turbo::description(),
            "Exports much faster using every CPU core and the GPU",
        ),
        (
            tr::editor::export::turbo::warning(),
            "Uses all of your CPU, the GPU and several times more memory until the export finishes. Other apps may slow down, and your computer may get warm and loud.",
        ),
        (tr::editor::window::clip_menu::transition(), "TRANSITION"),
        (tr::editor::window::clip_menu::transition_none(), "None"),
        (
            tr::editor::window::clip_menu::transition_crossfade(),
            "Crossfade",
        ),
        (tr::editor::window::clip_menu::transition_fade(), "Fade"),
        (tr::editor::timeline::title(), "Timeline"),
        (
            tr::editor::window::clip_menu::merge_blocker::edge(),
            "No clip on that side",
        ),
        (
            tr::editor::window::clip_menu::merge_blocker::different_recording(),
            "Different recording",
        ),
        (
            tr::editor::window::clip_menu::merge_blocker::gap(),
            "Footage was cut between them",
        ),
        (
            tr::editor::window::clip_menu::merge_blocker::speed(),
            "Match the clip speeds first",
        ),
        (tr::editor::tabs::font::system_sans_serif(), "System Sans-Serif"),
        (tr::editor::tabs::font::system_serif(), "System Serif"),
        (tr::editor::tabs::font::system_monospace(), "System Monospace"),
        (tr::ui::selection::select_all(), "Select all"),
    ];
    for (translated, literal) in pairs {
        assert_eq!(translated, literal);
    }
    let plain_keys = KEYS
        .iter()
        .filter(|key| is_editor_shell_surface_key(key))
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

#[test]
fn derived_track_copy_matches_the_sentences_it_replaced() {
    use crate::editor_timeline::TrackKind;
    for kind in [
        TrackKind::Clip,
        TrackKind::Style,
        TrackKind::Image,
        TrackKind::Caption,
        TrackKind::Keyboard,
        TrackKind::Text,
        TrackKind::Mask,
        TrackKind::Audio,
        TrackKind::Zoom,
        TrackKind::ThreeD,
        TrackKind::Scene,
    ] {
        assert_eq!(
            kind.picker_remove(),
            format!("Remove the {} track.", kind.picker_label())
        );
    }
    assert_eq!(
        tr::editor::timeline::empty::audio(),
        TrackKind::Audio.picker_description().trim_end_matches('.')
    );
    assert_eq!(
        tr::editor::timeline::empty::scene(),
        TrackKind::Scene.picker_description().trim_end_matches('.')
    );
    assert_eq!(tr::editor::window::preview::quarter(), "Quarter");
    assert_eq!(tr::editor::window::preview::half(), "Half");
    assert_eq!(tr::editor::window::preview::full(), "Full");
}

#[test]
fn editor_shell_messages_format_like_the_code_they_replaced() {
    let error = "disk full".to_string();
    let path = std::path::Path::new("/tmp/Demo.cap");
    let message = "Source Cap project is still recording".to_string();

    for seconds in [0.25, 0.5, 1.0] {
        assert_eq!(
            tr::editor::window::clip_menu::transition_seconds(seconds),
            format!("{seconds}s")
        );
    }
    assert_eq!(
        tr::editor::clips::append_error(&message),
        format!("Failed to add clip: {message}")
    );
    assert_eq!(
        tr::editor::clips::import_error(&message),
        format!("Failed to import clip: {message}")
    );
    for index in [0_usize, 1, 2, 5] {
        assert_eq!(
            tr::editor::clips::clip(index + 1),
            format!("Clip {}", index + 1)
        );
        assert_eq!(tr::editor::clips::split(index), format!("Split {}", index));
        assert_eq!(tr::editor::tabs::sync::clip(index), format!("Clip {index}"));
        assert_eq!(
            tr::editor::timeline::segment::numbered_clip(index as u32),
            format!("Clip {}", index as u32)
        );
        assert_eq!(
            tr::editor::window::frame::style_only(index + 1),
            format!("Style {} only · Global settings stay unchanged.", index + 1)
        );
        assert_eq!(
            tr::editor::window::frame::style_only_override(index + 1),
            format!(
                "Style {} only · Editing enables its background override.",
                index + 1
            )
        );
    }
    assert_eq!(
        tr::editor::clips::error::cannot_decode(path.display(), &error),
        format!("Cannot decode video {}: {error}", path.display())
    );
    assert_eq!(
        tr::editor::clips::error::in_use(&error),
        format!("Cannot import while this recording is in use: {error}")
    );
    assert_eq!(
        tr::editor::clips::error::missing_video(path.display()),
        format!("Missing video file: {}", path.display())
    );
    assert_eq!(
        tr::editor::clips::error::source_failed(&error),
        format!("Source Cap project failed: {error}")
    );
    assert_eq!(
        tr::editor::clips::error::unsupported_video(path.display()),
        format!("Unsupported video file: {}", path.display())
    );
    assert_eq!(
        tr::editor::clips::prepare_controls_failed(&error),
        format!("Could not prepare the recording controls: {error}")
    );
    assert_eq!(
        tr::editor::clips::save_before_recording_failed(&error),
        format!("Could not save the current project before recording: {error}")
    );

    for (lower, upper) in [(1.5_f64, 2.0_f64), (12.0, 41.0), (0.1, 3.4)] {
        for (single, range, unit) in [
            (
                tr::editor::export::estimate::gigabytes(lower),
                tr::editor::export::estimate::gigabytes_range(lower, upper),
                "GB",
            ),
            (
                tr::editor::export::estimate::megabytes(lower),
                tr::editor::export::estimate::megabytes_range(lower, upper),
                "MB",
            ),
            (
                tr::editor::export::estimate::hours(lower),
                tr::editor::export::estimate::hours_range(lower, upper),
                "hr",
            ),
            (
                tr::editor::export::estimate::minutes(lower),
                tr::editor::export::estimate::minutes_range(lower, upper),
                "min",
            ),
            (
                tr::editor::export::estimate::seconds(lower),
                tr::editor::export::estimate::seconds_range(lower, upper),
                "s",
            ),
        ] {
            assert_eq!(single, format!("~{lower} {unit}"));
            assert_eq!(range, format!("~{lower}–{upper} {unit}"));
        }
    }
    for fps in [24_u32, 30, 60] {
        assert_eq!(tr::editor::export::fps(&fps), format!("{fps} FPS"));
        assert_eq!(
            tr::editor::export::stats::output_value(1920_u32, 1080_u32, fps),
            format!("{}×{} · {} fps", 1920, 1080, fps)
        );
    }
    for total in [0_u32, 1, 2, 5] {
        let rendered = total / 2;
        let expected = if total == 1 {
            format!("{rendered} / {total} frame")
        } else {
            format!("{rendered} / {total} frames")
        };
        assert_eq!(
            tr::editor::export::frames(total as usize, rendered),
            expected
        );
    }

    let model = "Recommended";
    assert_eq!(
        tr::editor::tabs::captions::download(model),
        format!("Download {} Model", model)
    );
    for percent in [0_u32, 1, 42, 100] {
        assert_eq!(
            tr::editor::tabs::captions::downloading(model, percent),
            format!("Downloading {model}... {percent}%")
        );
    }
    assert_eq!(
        tr::editor::tabs::captions::model_downloaded(model),
        format!("{} model downloaded", model)
    );
    let reason = "No audio found in the video file".to_string();
    assert_eq!(
        tr::editor::tabs::captions::generate_failed(&reason),
        format!("Failed to generate captions: {}", reason)
    );
    assert_eq!(
        tr::editor::tabs::keyboard::load_failed(&error),
        format!("Failed to load recording data: {error}")
    );

    let look = "Glide across";
    for duration in [0.5_f64, 2.0, 3.25] {
        assert_eq!(
            tr::editor::timeline::add_shot_with_look(look, format!("{duration:.1}")),
            format!("Add shot \u{b7} {} \u{b7} {duration:.1}s", look)
        );
    }

    assert_eq!(
        tr::editor::window::audio_import::copy_failed(&error),
        format!("Failed to copy audio file: {error}")
    );
    assert_eq!(
        tr::editor::window::audio_import::directory_failed(&error),
        format!("Failed to create audio directory: {error}")
    );
    assert_eq!(
        tr::editor::window::audio_import::not_found(path.display()),
        format!("Audio file not found: {}", path.display())
    );
    let extension = "ogg".to_string();
    assert_eq!(
        tr::editor::window::audio_import::unsupported(&extension),
        format!("Unsupported audio format: .{extension}")
    );
    assert_eq!(
        tr::editor::window::busy::save_before_delete_failed(&error),
        format!("Could not save the recording before deleting it: {error}")
    );
    assert_eq!(
        tr::editor::window::open::media_failed(&error),
        format!("Failed to read this recording's media: {error}")
    );
    assert_eq!(
        tr::editor::window::open::meta_failed(&error),
        format!("Failed to load recording meta: {error}")
    );
    assert_eq!(
        tr::editor::window::open::not_found(path.display()),
        format!("Video path {} not found!", path.display())
    );
    let name = "Webinar".to_string();
    assert_eq!(
        tr::editor::window::presets::delete_confirm(&name),
        format!("Are you sure you want to delete \"{}\"?", name)
    );
    assert_eq!(
        tr::editor::window::save_failed(path.display(), &error),
        format!(
            "Could not save {}. Keep the editor open and try again: {error}",
            path.display()
        )
    );
    for count in [2_usize, 3, 5] {
        assert_eq!(
            tr::editor::window::text_menu::segments(count),
            format!("{count} text segments")
        );
    }
    assert_eq!(
        tr::editor::window::title::not_saved_message(&error),
        format!("{error}\n\nYour title is still in the editor. Try saving it again.")
    );
    assert_eq!(
        tr::editor::window::title::read_failed(path.display(), &error),
        format!(
            "Could not read the recording title for {}: {error}",
            path.display()
        )
    );
    assert_eq!(
        tr::editor::window::title::save_failed(path.display(), &error),
        format!(
            "Could not save the recording title for {}: {error}",
            path.display()
        )
    );
}

#[test]
fn selection_headers_read_as_whole_sentences() {
    let old = |noun: &str, count: usize| {
        format!(
            "{count} {noun} segment{} selected",
            if count == 1 { "" } else { "s" }
        )
    };
    for count in [0, 1, 2, 5] {
        for noun in [
            "style", "image", "text", "caption", "audio", "mask", "keyboard", "3D", "scene",
        ] {
            assert_eq!(crate::ui::selection_label(noun, count), old(noun, count));
        }
        assert_eq!(
            tr::ui::selection::segments(count),
            if count == 1 {
                format!("{count} segment selected")
            } else {
                format!("{count} segments selected")
            }
        );
    }
    let old_zoom = |count: usize, total: usize| {
        if total > 1 && count == total {
            format!("All {total} selected")
        } else if total > 1 {
            format!("{count} of {total} selected")
        } else {
            format!("{count} selected")
        }
    };
    for (count, total) in [(0, 0), (1, 1), (1, 2), (2, 2), (2, 5), (5, 5)] {
        assert_eq!(
            crate::ui::zoom_selection_label(count, total),
            old_zoom(count, total)
        );
    }
}
