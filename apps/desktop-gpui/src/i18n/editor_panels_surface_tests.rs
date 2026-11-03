use super::*;

pub(super) fn is_editor_panels_surface_key(key: &str) -> bool {
    [
        "editor.panel.",
        "editor.sidebar.",
        "editor.color.",
        "editor.audio.",
        "editor.crop.",
    ]
    .iter()
    .any(|prefix| key.starts_with(prefix))
}

const FORMATTED: &[&str] = &[
    "editor.panel.zoom.title",
    "editor.panel.font_weight.custom",
    "editor.panel.text_segment.title",
    "editor.panel.caption.title",
    "editor.panel.keyboard.title",
    "editor.panel.audio.title",
    "editor.panel.mask.title",
    "editor.panel.camera3d.shots",
    "editor.panel.camera3d.pose_start",
    "editor.panel.camera3d.pose_end",
    "editor.panel.camera3d.header",
    "editor.panel.camera3d.timing_summary",
    "editor.sidebar.style_group.title",
    "editor.sidebar.animated_gradient.limit_reached",
    "editor.crop.hint",
    "editor.crop.editing_style",
    "editor.crop.editing_style_override",
];

#[test]
fn editor_panels_match_the_literals_they_replaced() {
    let pairs: &[(&str, &str)] = &[
        (tr::editor::panel::done(), "Done"),
        (tr::editor::panel::delete(), "Delete"),
        (tr::editor::panel::enabled(), "Enabled"),
        (tr::editor::panel::name(), "Name"),
        (tr::editor::panel::duration(), "Duration"),
        (tr::editor::panel::fade_duration(), "Fade Duration"),
        (tr::editor::panel::flip_horizontally(), "Flip horizontally"),
        (tr::editor::panel::flip_vertically(), "Flip vertically"),
        (tr::editor::panel::opacity(), "Opacity"),
        (tr::editor::panel::edge_in(), "In"),
        (tr::editor::panel::edge_out(), "Out"),
        (tr::editor::panel::zoom::mode(), "Zoom Mode"),
        (tr::editor::panel::zoom::amount(), "Zoom Amount"),
        (tr::editor::panel::zoom::mixed(), "Mixed"),
        (
            tr::editor::panel::zoom::positions_mixed(),
            "Segments zoom into different spots. Drag to move them all to the same one.",
        ),
        (tr::editor::panel::zoom::auto(), "Auto"),
        (tr::editor::panel::zoom::manual(), "Manual"),
        (
            tr::editor::panel::zoom::auto_locked(),
            "Auto mode needs cursor capture. Enable \"Custom cursor capture (Studio)\" in Settings → General.",
        ),
        (tr::editor::panel::zoom::how_it_works(), "How does it work?"),
        (
            tr::editor::panel::zoom::manual_help(),
            "Manual zoom stays on a fixed spot you pick below.",
        ),
        (
            tr::editor::panel::zoom::auto_help(),
            "Automatic zoom follows your cursor around the screen.",
        ),
        (tr::editor::panel::font_weight::light(), "Light"),
        (tr::editor::panel::font_weight::regular(), "Regular"),
        (tr::editor::panel::font_weight::medium(), "Medium"),
        (tr::editor::panel::font_weight::semibold(), "Semibold"),
        (tr::editor::panel::font_weight::bold(), "Bold"),
        (tr::editor::panel::font_weight::extra_bold(), "Extra Bold"),
        (tr::editor::panel::font_weight::black(), "Black"),
        (tr::editor::panel::text_animation::none(), "None"),
        (tr::editor::panel::text_animation::fade(), "Fade"),
        (tr::editor::panel::text_animation::slide_up(), "Slide up"),
        (
            tr::editor::panel::text_animation::slide_down(),
            "Slide down",
        ),
        (
            tr::editor::panel::text_animation::slide_left(),
            "Slide left",
        ),
        (
            tr::editor::panel::text_animation::slide_right(),
            "Slide right",
        ),
        (tr::editor::panel::text_animation::pop(), "Pop"),
        (tr::editor::panel::text_animation::zoom(), "Zoom"),
        (tr::editor::panel::text_animation::bounce(), "Bounce"),
        (tr::editor::panel::text_animation::wipe(), "Wipe"),
        (tr::editor::panel::text_animation::words(), "Words"),
        (tr::editor::panel::text_animation::letters(), "Letters"),
        (tr::editor::panel::text_animation::tracking(), "Tracking"),
        (
            tr::editor::panel::text_animation::typewriter(),
            "Typewriter",
        ),
        (tr::editor::panel::text_background::none(), "None"),
        (tr::editor::panel::text_background::box_shape(), "Box"),
        (tr::editor::panel::text_background::pill(), "Pill"),
        (tr::editor::panel::text_background::highlight(), "Highlight"),
        (tr::editor::panel::text_layout::overlay(), "Overlay"),
        (tr::editor::panel::text_layout::fullscreen(), "Fullscreen"),
        (tr::editor::panel::text_preset::group::all(), "All"),
        (tr::editor::panel::text_preset::group::titles(), "Titles"),
        (
            tr::editor::panel::text_preset::group::lower_thirds(),
            "Lower thirds",
        ),
        (
            tr::editor::panel::text_preset::group::callouts(),
            "Callouts",
        ),
        (
            tr::editor::panel::text_preset::group::statements(),
            "Statements",
        ),
        (tr::editor::panel::text_preset::group::code(), "Code"),
        (tr::editor::panel::text_preset::name::title(), "Title"),
        (tr::editor::panel::text_preset::name::headline(), "Headline"),
        (
            tr::editor::panel::text_preset::name::cinematic(),
            "Cinematic",
        ),
        (tr::editor::panel::text_preset::name::gradient(), "Gradient"),
        (
            tr::editor::panel::text_preset::name::lower_third(),
            "Lower third",
        ),
        (tr::editor::panel::text_preset::name::name_tag(), "Name tag"),
        (tr::editor::panel::text_preset::name::caption(), "Caption"),
        (tr::editor::panel::text_preset::name::kicker(), "Kicker"),
        (tr::editor::panel::text_preset::name::label(), "Label"),
        (
            tr::editor::panel::text_preset::name::highlight(),
            "Highlight",
        ),
        (tr::editor::panel::text_preset::name::sticker(), "Sticker"),
        (tr::editor::panel::text_preset::name::neon(), "Neon"),
        (tr::editor::panel::text_preset::name::stat(), "Big stat"),
        (tr::editor::panel::text_preset::name::quote(), "Quote"),
        (tr::editor::panel::text_preset::name::code(), "Code"),
        (
            tr::editor::panel::text_preset::name::typewriter(),
            "Typewriter",
        ),
        (
            tr::editor::panel::text_preset::sample::title(),
            "Introducing Cap",
        ),
        (
            tr::editor::panel::text_preset::sample::headline(),
            "Ship faster",
        ),
        (
            tr::editor::panel::text_preset::sample::cinematic(),
            "Chapter one",
        ),
        (
            tr::editor::panel::text_preset::sample::gradient(),
            "Beautiful text",
        ),
        (
            tr::editor::panel::text_preset::sample::name_tag(),
            "Richie · Founder",
        ),
        (
            tr::editor::panel::text_preset::sample::caption(),
            "Recorded with Cap",
        ),
        (
            tr::editor::panel::text_preset::sample::kicker(),
            "New feature",
        ),
        (tr::editor::panel::text_preset::sample::label(), "Pro tip"),
        (
            tr::editor::panel::text_preset::sample::highlight(),
            "the important part",
        ),
        (tr::editor::panel::text_preset::sample::sticker(), "Boom!"),
        (tr::editor::panel::text_preset::sample::neon(), "Glow up"),
        (
            tr::editor::panel::text_preset::sample::quote(),
            "“Make it feel effortless”",
        ),
        (
            tr::editor::panel::text_preset::sample::typewriter(),
            "typing it out…",
        ),
        (tr::editor::panel::font::system_sans(), "System Sans"),
        (tr::editor::panel::font::system_serif(), "System Serif"),
        (tr::editor::panel::font::system_mono(), "System Mono"),
        (tr::editor::panel::text_segment::style(), "Style"),
        (tr::editor::panel::text_segment::font(), "Font"),
        (tr::editor::panel::text_segment::font_size(), "Size"),
        (
            tr::editor::panel::text_segment::line_height(),
            "Line height",
        ),
        (
            tr::editor::panel::text_segment::letter_spacing(),
            "Letter spacing",
        ),
        (tr::editor::panel::text_segment::look(), "Look"),
        (tr::editor::panel::text_segment::color(), "Color"),
        (tr::editor::panel::text_segment::gradient(), "Gradient"),
        (tr::editor::panel::text_segment::background(), "Background"),
        (tr::editor::panel::text_segment::outline(), "Outline"),
        (tr::editor::panel::text_segment::shadow(), "Shadow"),
        (tr::editor::panel::text_segment::glow(), "Glow"),
        (tr::editor::panel::text_segment::animation(), "Animation"),
        (tr::editor::panel::text_segment::layout(), "Layout"),
        (
            tr::editor::panel::text_segment::fullscreen_help(),
            "Pauses the video while the text is shown, then resumes where it left off.",
        ),
        (
            tr::editor::panel::text_segment::screen_transition(),
            "Screen transition",
        ),
        (tr::editor::panel::timing::title(), "Timing"),
        (tr::editor::panel::timing::start(), "Start"),
        (tr::editor::panel::timing::to(), "to"),
        (tr::editor::panel::timing::end(), "End"),
        (tr::editor::panel::audio::fallback_name(), "Audio"),
        (
            tr::editor::panel::audio::change_hint(),
            "Tap to change track",
        ),
        (tr::editor::panel::audio::change(), "Change"),
        (tr::editor::panel::audio::volume(), "Volume"),
        (tr::editor::panel::audio::fade_in(), "Fade In"),
        (tr::editor::panel::audio::fade_out(), "Fade Out"),
        (tr::editor::panel::mask::sensitive(), "Sensitive"),
        (tr::editor::panel::mask::highlight(), "Highlight"),
        (tr::editor::panel::mask::effect(), "Effect"),
        (tr::editor::panel::mask::blur(), "Blur"),
        (tr::editor::panel::mask::pixelate(), "Pixelate"),
        (tr::editor::panel::mask::pixel_size(), "Pixel Size"),
        (
            tr::editor::panel::mask::outside_darkness(),
            "Outside Darkness",
        ),
        (tr::editor::panel::scene::camera_layout(), "Camera Layout"),
        (tr::editor::panel::scene::transition(), "Transition"),
        (tr::editor::panel::scene::screen_zoom(), "Screen Zoom"),
        (
            tr::editor::panel::scene::screen_position(),
            "Screen Position",
        ),
        (tr::editor::panel::scene::camera_zoom(), "Camera Zoom"),
        (
            tr::editor::panel::scene::camera_position(),
            "Camera Position",
        ),
        (tr::editor::panel::scene::mode::default(), "Default"),
        (tr::editor::panel::scene::mode::camera_only(), "Camera Only"),
        (tr::editor::panel::scene::mode::hide_camera(), "Hide Camera"),
        (
            tr::editor::panel::scene::mode::split_screen(),
            "Split Screen",
        ),
        (tr::editor::panel::scene::mode::floating(), "Floating"),
        (
            tr::editor::panel::scene::description::default(),
            "Shows both screen and camera",
        ),
        (
            tr::editor::panel::scene::description::camera_only(),
            "Shows only the camera feed",
        ),
        (
            tr::editor::panel::scene::description::hide_camera(),
            "Shows only the screen recording",
        ),
        (
            tr::editor::panel::scene::description::split_screen(),
            "Screen and camera side by side (auto-stacks in portrait)",
        ),
        (
            tr::editor::panel::scene::description::floating(),
            "Screen and camera float side by side as rounded cards over the background",
        ),
        (tr::editor::panel::camera3d::look_title(), "Look"),
        (tr::editor::panel::camera3d::moves(), "Moves"),
        (tr::editor::panel::camera3d::angles(), "Angles"),
        (
            tr::editor::panel::camera3d::drag_to_orbit(),
            "Drag to orbit",
        ),
        (
            tr::editor::panel::camera3d::end_same_as_start(),
            "End · same as start",
        ),
        (
            tr::editor::panel::camera3d::nothing_to_swap(),
            "Nothing to swap on a still shot",
        ),
        (tr::editor::panel::camera3d::swap(), "Swap start and end"),
        (tr::editor::panel::camera3d::still_shot(), "Still shot"),
        (
            tr::editor::panel::camera3d::already_still(),
            "Already a still shot",
        ),
        (
            tr::editor::panel::camera3d::hold_opening(),
            "Hold the opening pose for the whole shot",
        ),
        (tr::editor::panel::camera3d::auto_scene(), "Auto scene"),
        (
            tr::editor::panel::camera3d::auto_scene_tooltip(),
            "Rebuilds every 3D shot on the track",
        ),
        (tr::editor::panel::camera3d::play_shot(), "Play shot"),
        (
            tr::editor::panel::camera3d::play_shot_tooltip(),
            "Play this shot",
        ),
        (
            tr::editor::panel::camera3d::delete_tooltip(),
            "Delete this shot",
        ),
        (tr::editor::panel::camera3d::camera(), "Camera"),
        (tr::editor::panel::camera3d::distance(), "Distance"),
        (tr::editor::panel::camera3d::roll(), "Roll"),
        (tr::editor::panel::camera3d::shift_x(), "Shift X"),
        (tr::editor::panel::camera3d::shift_y(), "Shift Y"),
        (tr::editor::panel::camera3d::depth_blur(), "Depth blur"),
        (tr::editor::panel::camera3d::amount(), "Amount"),
        (tr::editor::panel::camera3d::focus(), "Focus"),
        (tr::editor::panel::camera3d::fine_tune(), "Fine-tune"),
        (tr::editor::panel::camera3d::bokeh(), "Bokeh"),
        (
            tr::editor::panel::camera3d::timing_advanced(),
            "Timing & advanced",
        ),
        (tr::editor::panel::camera3d::motion_style(), "Motion style"),
        (tr::editor::panel::camera3d::ease_in(), "Ease in"),
        (tr::editor::panel::camera3d::ease_out(), "Ease out"),
        (tr::editor::panel::camera3d::lens(), "Lens"),
        (tr::editor::panel::camera3d::rotate_x(), "Rotate X"),
        (tr::editor::panel::camera3d::rotate_y(), "Rotate Y"),
        (tr::editor::panel::camera3d::reset_camera(), "Reset camera"),
        (tr::editor::panel::camera3d::shot::still(), "Still shot"),
        (tr::editor::panel::camera3d::shot::custom(), "Custom move"),
        (tr::editor::panel::camera3d::look::spotlight(), "Spotlight"),
        (
            tr::editor::panel::camera3d::look::perspective(),
            "Perspective",
        ),
        (tr::editor::panel::camera3d::look::center(), "Center"),
        (tr::editor::panel::camera3d::look::low_angle(), "Low angle"),
        (tr::editor::panel::camera3d::look::close_up(), "Close up"),
        (
            tr::editor::panel::camera3d::look::glide_across(),
            "Glide across",
        ),
        (
            tr::editor::panel::camera3d::look::drift_down(),
            "Drift down",
        ),
        (
            tr::editor::panel::camera3d::look::rising_sweep(),
            "Rising sweep",
        ),
        (tr::editor::panel::camera3d::look::pull_back(), "Pull back"),
        (tr::editor::panel::camera3d::look::top_down(), "Top down"),
        (tr::editor::panel::camera3d::look::tilt_away(), "Tilt away"),
        (tr::editor::panel::camera3d::look::unfold(), "Unfold"),
        (tr::editor::panel::camera3d::look::slide_by(), "Slide by"),
        (
            tr::editor::panel::camera3d::sequence::showcase(),
            "Showcase",
        ),
        (
            tr::editor::panel::camera3d::sequence::product_tour(),
            "Product tour",
        ),
        (
            tr::editor::panel::camera3d::sequence::punch_in(),
            "Punch in",
        ),
        (tr::editor::panel::camera3d::easing::linear(), "Linear"),
        (tr::editor::panel::camera3d::easing::smooth(), "Smooth"),
        (tr::editor::panel::camera3d::easing::ease_in(), "Ease in"),
        (tr::editor::panel::camera3d::easing::ease_out(), "Ease out"),
        (tr::editor::panel::camera3d::focus_mode::radial(), "Radial"),
        (
            tr::editor::panel::camera3d::focus_mode::directional(),
            "Directional",
        ),
        (
            tr::editor::panel::camera3d::focus_mode::tilt_shift(),
            "Tilt shift",
        ),
        (tr::editor::panel::camera3d::blur::strength(), "Strength"),
        (tr::editor::panel::camera3d::blur::focus_x(), "Focus X"),
        (tr::editor::panel::camera3d::blur::focus_y(), "Focus Y"),
        (
            tr::editor::panel::camera3d::blur::focus_size(),
            "Focus size",
        ),
        (tr::editor::panel::camera3d::blur::falloff(), "Falloff"),
        (tr::editor::panel::camera3d::blur::angle(), "Angle"),
        (tr::editor::panel::camera3d::blur::position(), "Position"),
        (tr::editor::panel::camera3d::blur::scan(), "Scan"),
        (tr::editor::panel::image::arrange(), "Arrange on canvas"),
        (
            tr::editor::panel::image::arrange_help(),
            "Drag the image to move it. Pull a corner to resize, or use the rotation control below to turn it.",
        ),
        (tr::editor::panel::image::center(), "Center on canvas"),
        (tr::editor::panel::image::replace(), "Replace image"),
        (
            tr::editor::panel::image::missing(),
            "Image file is missing. Replace it to restore this segment while keeping its timing and transforms.",
        ),
        (tr::editor::panel::image::lock_aspect(), "Lock aspect ratio"),
        (tr::editor::panel::image::rotation(), "Rotation"),
        (tr::editor::panel::image::rounding(), "Rounding"),
        (
            tr::editor::panel::style::help(),
            "Overrides apply only during this segment. Enable a group to copy its global settings.",
        ),
        (
            tr::editor::panel::style::edit_background(),
            "Edit Background & frame",
        ),
        (tr::editor::panel::style::edit_camera(), "Edit Camera"),
        (tr::editor::panel::style::edit_cursor(), "Edit Cursor"),
        (
            tr::editor::panel::style::crop_title(),
            "Screen crop (source pixels)",
        ),
        (tr::editor::panel::style::crop_left(), "Left"),
        (tr::editor::panel::style::crop_top(), "Top"),
        (tr::editor::panel::style::crop_width(), "Width"),
        (tr::editor::panel::style::crop_height(), "Height"),
        (tr::editor::panel::style::reset_crop(), "Reset crop"),
        (
            tr::editor::panel::style::camera_only_background(),
            "Camera Only background",
        ),
        (
            tr::editor::panel::style::camera_only_padding(),
            "Camera Only padding",
        ),
        (
            tr::editor::panel::style::camera_only_help(),
            "Use a Camera Only scene. Padding reveals the background around the camera.",
        ),
        (tr::editor::sidebar::tab::background(), "Background"),
        (tr::editor::sidebar::tab::camera(), "Camera"),
        (tr::editor::sidebar::tab::audio(), "Audio"),
        (tr::editor::sidebar::tab::cursor(), "Cursor"),
        (tr::editor::sidebar::tab::keyboard(), "Keyboard"),
        (tr::editor::sidebar::tab::captions(), "Captions"),
        (tr::editor::sidebar::source::desktop(), "Desktop"),
        (tr::editor::sidebar::source::wallpaper(), "Wallpaper"),
        (tr::editor::sidebar::source::image(), "Image"),
        (tr::editor::sidebar::source::color(), "Color"),
        (tr::editor::sidebar::source::gradient(), "Gradient"),
        (tr::editor::sidebar::source::animated(), "Animated"),
        (tr::editor::sidebar::source::none(), "None"),
        (tr::editor::sidebar::wallpaper_theme::dark(), "Dark"),
        (tr::editor::sidebar::wallpaper_theme::blue(), "Blue"),
        (tr::editor::sidebar::wallpaper_theme::cities(), "Cities"),
        (tr::editor::sidebar::wallpaper_theme::purple(), "Purple"),
        (tr::editor::sidebar::wallpaper_theme::orange(), "Orange"),
        (tr::editor::sidebar::importing_image(), "Importing image…"),
        (
            tr::editor::sidebar::desktop_import_failed(),
            "Couldn't import your desktop wallpaper",
        ),
        (tr::editor::sidebar::layout::title(), "Layout"),
        (
            tr::editor::sidebar::layout::background_blur(),
            "Background Blur",
        ),
        (tr::editor::sidebar::layout::padding(), "Padding"),
        (
            tr::editor::sidebar::layout::custom_position(),
            "Custom screen position (dragged on canvas)",
        ),
        (
            tr::editor::sidebar::layout::rounded_corners(),
            "Rounded Corners",
        ),
        (tr::editor::sidebar::layout::motion_blur(), "Motion Blur"),
        (tr::editor::sidebar::background::title(), "Background"),
        (tr::editor::sidebar::desktop::importing(), "Importing..."),
        (
            tr::editor::sidebar::desktop::import(),
            "Import desktop background",
        ),
        (
            tr::editor::sidebar::desktop::prompt(),
            "Use the wallpaper from your desktop",
        ),
        (tr::editor::sidebar::desktop::reimport(), "Re-import"),
        (
            tr::editor::sidebar::image::prompt(),
            "Click to select or drag and drop image",
        ),
        (tr::editor::sidebar::gradient::from(), "From"),
        (tr::editor::sidebar::gradient::to(), "To"),
        (tr::editor::sidebar::gradient::angle(), "Angle"),
        (tr::editor::sidebar::gradient::noise(), "Noise"),
        (tr::editor::sidebar::gradient::grain_scale(), "Grain Scale"),
        (tr::editor::sidebar::corner::title(), "Corner Style"),
        (tr::editor::sidebar::corner::squircle(), "Squircle"),
        (tr::editor::sidebar::corner::rounded(), "Rounded"),
        (tr::editor::sidebar::border::title(), "Border"),
        (tr::editor::sidebar::border::width(), "Border Width"),
        (tr::editor::sidebar::border::color(), "Border Color"),
        (tr::editor::sidebar::border::opacity(), "Border Opacity"),
        (tr::editor::sidebar::notch::title(), "MacBook notch"),
        (
            tr::editor::sidebar::notch::description(),
            "Draws a MacBook notch over the recording. Recordings made on a Mac with a notch use their own measurements; otherwise start from the size below and adjust to match.",
        ),
        (tr::editor::sidebar::notch::width(), "Notch Width"),
        (tr::editor::sidebar::notch::height(), "Notch Height"),
        (tr::editor::sidebar::notch::position(), "Notch Position"),
        (tr::editor::sidebar::shadow::title(), "Shadow"),
        (
            tr::editor::sidebar::shadow::advanced(),
            "Advanced shadow settings",
        ),
        (tr::editor::sidebar::shadow::shadow_size(), "Size"),
        (tr::editor::sidebar::shadow::opacity(), "Opacity"),
        (tr::editor::sidebar::shadow::blur(), "Blur"),
        (
            tr::editor::sidebar::style_group::background(),
            "Background & frame",
        ),
        (tr::editor::sidebar::style_group::camera(), "Camera"),
        (tr::editor::sidebar::style_group::cursor(), "Cursor"),
        (
            tr::editor::sidebar::style_group::editing_note(),
            "Editing this segment only. Global settings are unchanged.",
        ),
        (tr::editor::sidebar::style_group::back(), "Back to Style"),
        (tr::editor::sidebar::cursor::default(), "Default"),
        (tr::editor::sidebar::cursor::circle(), "Circle"),
        (tr::editor::sidebar::cursor::recorded(), "Recorded cursors"),
        (
            tr::editor::sidebar::cursor::recorded_tooltip(),
            "Recorded with this cursor",
        ),
        (
            tr::editor::sidebar::cursor::description_default(),
            "Keeps the cursor shapes and appearance from your recording.",
        ),
        (
            tr::editor::sidebar::cursor::description_macos(),
            "Classic macOS appearance. Custom cursors keep their recorded shape.",
        ),
        (
            tr::editor::sidebar::cursor::description_tahoe(),
            "macOS Tahoe appearance. Custom cursors keep their recorded shape.",
        ),
        (
            tr::editor::sidebar::cursor::description_windows(),
            "Windows appearance. Custom cursors keep their recorded shape.",
        ),
        (
            tr::editor::sidebar::cursor::description_circle(),
            "Replaces all cursor shapes with a circle.",
        ),
        (tr::editor::sidebar::cursor::click_ripple(), "Click Ripple"),
        (tr::editor::sidebar::cursor::color(), "Color"),
        (tr::editor::sidebar::cursor::strength(), "Strength"),
        (tr::editor::sidebar::cursor::ripple_size(), "Size"),
        (tr::editor::sidebar::cursor::duration(), "Duration"),
        (tr::editor::sidebar::animated_gradient::still(), "Still"),
        (
            tr::editor::sidebar::animated_gradient::name_placeholder(),
            "Name this gradient",
        ),
        (
            tr::editor::sidebar::animated_gradient::name_required(),
            "Enter a name for this gradient.",
        ),
        (
            tr::editor::sidebar::animated_gradient::save_failed(),
            "Could not save this gradient. Try again.",
        ),
        (
            tr::editor::sidebar::animated_gradient::delete_failed(),
            "Could not delete this gradient. Try again.",
        ),
        (
            tr::editor::sidebar::animated_gradient::remember_failed(),
            "Could not remember your animated gradient settings.",
        ),
        (
            tr::editor::sidebar::animated_gradient::randomize(),
            "Randomize",
        ),
        (tr::editor::sidebar::animated_gradient::presets(), "Presets"),
        (
            tr::editor::sidebar::animated_gradient::save_tooltip(),
            "Save the current gradient",
        ),
        (tr::editor::sidebar::animated_gradient::saved(), "Saved"),
        (tr::editor::sidebar::animated_gradient::delete(), "Delete"),
        (
            tr::editor::sidebar::animated_gradient::remove_colour(),
            "Remove colour",
        ),
        (tr::editor::sidebar::animated_gradient::colours(), "Colours"),
        (
            tr::editor::sidebar::animated_gradient::add_colour(),
            "Add a colour",
        ),
        (tr::editor::sidebar::animated_gradient::motion(), "Motion"),
        (
            tr::editor::sidebar::animated_gradient::fine_tune(),
            "Fine-tune",
        ),
        (
            tr::editor::sidebar::animated_gradient::reset_tooltip(),
            "Reset fine-tune settings",
        ),
        (
            tr::editor::sidebar::animated_gradient::control::direction(),
            "Direction",
        ),
        (
            tr::editor::sidebar::animated_gradient::control::flow_scale(),
            "Flow Scale",
        ),
        (
            tr::editor::sidebar::animated_gradient::control::flow_strength(),
            "Flow Strength",
        ),
        (
            tr::editor::sidebar::animated_gradient::control::curvature(),
            "Curvature",
        ),
        (
            tr::editor::sidebar::animated_gradient::control::detail(),
            "Detail",
        ),
        (
            tr::editor::sidebar::animated_gradient::control::relief(),
            "Relief",
        ),
        (
            tr::editor::sidebar::animated_gradient::control::highlights(),
            "Highlights",
        ),
        (
            tr::editor::sidebar::animated_gradient::control::shading(),
            "Shading",
        ),
        (
            tr::editor::sidebar::animated_gradient::control::ripple_size(),
            "Ripple Size",
        ),
        (
            tr::editor::sidebar::animated_gradient::control::grain_amount(),
            "Grain Amount",
        ),
        (
            tr::editor::sidebar::animated_gradient::control::grain_size(),
            "Grain Size",
        ),
        (
            tr::editor::sidebar::animated_gradient::control::exposure(),
            "Exposure",
        ),
        (
            tr::editor::sidebar::animated_gradient::control::contrast(),
            "Contrast",
        ),
        (
            tr::editor::sidebar::animated_gradient::control::vibrance(),
            "Vibrance",
        ),
        (
            tr::editor::sidebar::animated_gradient::control::motion_speed(),
            "Motion Speed",
        ),
        (
            tr::editor::sidebar::animated_gradient::group::flow(),
            "Flow",
        ),
        (
            tr::editor::sidebar::animated_gradient::group::lighting(),
            "Lighting",
        ),
        (
            tr::editor::sidebar::animated_gradient::group::texture(),
            "Texture",
        ),
        (
            tr::editor::sidebar::animated_gradient::group::colour(),
            "Colour",
        ),
        (
            tr::editor::sidebar::animated_gradient::group::animation(),
            "Animation",
        ),
        (tr::editor::color::title(), "Color Correction"),
        (tr::editor::color::apply_to_cursor(), "Apply to cursor"),
        (tr::editor::color::fine_tune(), "Fine-tune colors"),
        (tr::editor::color::preset::none::name(), "None"),
        (
            tr::editor::color::preset::none::description(),
            "Original colors, no grade applied",
        ),
        (tr::editor::color::preset::cinematic::name(), "Cinematic"),
        (
            tr::editor::color::preset::cinematic::description(),
            "Teal shadows and orange highlights with light grain",
        ),
        (tr::editor::color::preset::noir::name(), "Noir"),
        (
            tr::editor::color::preset::noir::description(),
            "High-contrast black and white with heavy grain",
        ),
        (tr::editor::color::preset::vintage::name(), "Vintage"),
        (
            tr::editor::color::preset::vintage::description(),
            "Faded warm film look with soft contrast",
        ),
        (tr::editor::color::preset::frost::name(), "Frost"),
        (
            tr::editor::color::preset::frost::description(),
            "Cool, crisp tones with muted color",
        ),
        (tr::editor::color::preset::golden::name(), "Golden"),
        (
            tr::editor::color::preset::golden::description(),
            "Warm golden-hour glow",
        ),
        (tr::editor::color::preset::midnight::name(), "Midnight"),
        (
            tr::editor::color::preset::midnight::description(),
            "Dark, moody teal with subdued color",
        ),
        (tr::editor::color::preset::vivid::name(), "Vivid"),
        (
            tr::editor::color::preset::vivid::description(),
            "Punchy saturation and contrast boost",
        ),
        (tr::editor::color::preset::dreamy::name(), "Dreamy"),
        (
            tr::editor::color::preset::dreamy::description(),
            "Soft, airy pastels with lifted blacks",
        ),
        (tr::editor::color::slider::grain(), "Grain"),
        (tr::editor::color::slider::strength(), "Strength"),
        (tr::editor::color::slider::exposure(), "Exposure"),
        (tr::editor::color::slider::contrast(), "Contrast"),
        (tr::editor::color::slider::saturation(), "Saturation"),
        (tr::editor::color::slider::temperature(), "Temperature"),
        (tr::editor::color::slider::tint(), "Tint"),
        (tr::editor::color::slider::fade(), "Fade"),
        (tr::editor::color::slider::split_tone(), "Split Tone"),
        (tr::editor::color::slider::vignette(), "Vignette"),
        (tr::editor::audio::library::done(), "Done"),
        (tr::editor::audio::library::change_title(), "Change audio"),
        (tr::editor::audio::library::add_title(), "Add audio"),
        (
            tr::editor::audio::library::change_hint(),
            "Pick a different track for this segment",
        ),
        (
            tr::editor::audio::library::add_hint(),
            "Add audio, music or other sounds to your video",
        ),
        (tr::editor::audio::library::import(), "Import file"),
        (tr::editor::crop::title(), "Crop"),
        (tr::editor::crop::free(), "Free"),
        (tr::editor::crop::snap_to_ratios(), "Snap to ratios"),
        (
            tr::editor::crop::style_changed(),
            "This Style changed while cropping. Cancel and reopen Crop.",
        ),
        (tr::editor::crop::preview(), "Preview"),
        (tr::editor::crop::aspect_ratio(), "Aspect ratio"),
        (tr::editor::crop::dimensions(), "Size"),
        (tr::editor::crop::position(), "Position"),
        (tr::editor::crop::center(), "Center"),
        (tr::editor::crop::full(), "Full"),
        (tr::editor::crop::loading_frame(), "Loading frame…"),
        (tr::editor::crop::rendering_preview(), "Rendering preview…"),
    ];
    for (translated, literal) in pairs {
        assert_eq!(translated, literal);
    }
    let plain_keys = KEYS
        .iter()
        .filter(|key| is_editor_panels_surface_key(key))
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
fn editor_panel_messages_format_like_the_code_they_replaced() {
    for index in [0_usize, 1, 4, 11] {
        let number = index + 1;
        assert_eq!(
            tr::editor::panel::zoom::title(number),
            format!("Zoom {}", index + 1)
        );
        assert_eq!(
            tr::editor::panel::text_segment::title(number),
            format!("Text {}", index + 1)
        );
        assert_eq!(
            tr::editor::panel::caption::title(number),
            format!("Caption {}", index + 1)
        );
        assert_eq!(
            tr::editor::panel::keyboard::title(number),
            format!("Keyboard {}", index + 1)
        );
        assert_eq!(
            tr::editor::panel::audio::title(number),
            format!("Audio {}", index + 1)
        );
        assert_eq!(
            tr::editor::panel::mask::title(number),
            format!("Mask {}", index + 1)
        );
        assert_eq!(
            tr::editor::crop::editing_style(number),
            format!("Editing Style {} only", index + 1)
        );
        assert_eq!(
            tr::editor::crop::editing_style_override(number),
            format!(
                "Editing Style {} only · Saving enables its background override",
                index + 1
            )
        );
        for (group, label) in [
            (
                tr::editor::sidebar::style_group::background(),
                "Background & frame",
            ),
            (tr::editor::sidebar::style_group::camera(), "Camera"),
            (tr::editor::sidebar::style_group::cursor(), "Cursor"),
        ] {
            assert_eq!(
                tr::editor::sidebar::style_group::title(number, group),
                format!("Style {} · {}", index + 1, label)
            );
        }
    }

    for weight in [450_f32, 350., 725.5, 1000.] {
        assert_eq!(
            tr::editor::panel::font_weight::custom(weight),
            format!("Custom ({})", weight)
        );
    }

    for scene in crate::editor_panels::CAMERA3D_SCENES {
        let shots = scene.shots.len();
        assert_eq!(
            tr::editor::panel::camera3d::shots(shots),
            format!("{shots} shots")
        );
    }
    assert_eq!(tr::editor::panel::camera3d::shots(0), "0 shots");
    assert_eq!(tr::editor::panel::camera3d::shots(1), "1 shot");
    assert_eq!(tr::editor::panel::camera3d::shots(2), "2 shots");
    assert_eq!(tr::editor::panel::camera3d::shots(5), "5 shots");

    for time in ["0:00.0", "0:04.5", "12:03.2", "1:02:03.4"] {
        assert_eq!(
            tr::editor::panel::camera3d::pose_start(time),
            format!("{} \u{b7} {}", "Start", time)
        );
        assert_eq!(
            tr::editor::panel::camera3d::pose_end(time),
            format!("{} \u{b7} {}", "End", time)
        );
    }

    for (look, duration) in [
        ("Glide across", 4.0_f64),
        ("Still shot", 0.25),
        ("Custom move", 12.96),
    ] {
        assert_eq!(
            tr::editor::panel::camera3d::header(look, format!("{duration:.1}")),
            format!("3D shot \u{b7} {look} \u{b7} {duration:.1}s")
        );
    }

    for (easing_label, fov) in [("Smooth", 24.4_f64), ("Linear", 45.), ("Ease out", 119.6)] {
        assert_eq!(
            tr::editor::panel::camera3d::timing_summary(easing_label, fov.round() as i32),
            format!("{easing_label} \u{b7} Lens {}", fov.round() as i32)
        );
    }

    for saved in [2_usize, 5, 12] {
        assert_eq!(
            tr::editor::sidebar::animated_gradient::limit_reached(saved),
            format!("You can save up to {saved} gradients. Delete one to add another.")
        );
    }
    assert_eq!(
        tr::editor::sidebar::animated_gradient::limit_reached(0),
        "You can save up to 0 gradients. Delete one to add another."
    );
    assert_eq!(
        tr::editor::sidebar::animated_gradient::limit_reached(1),
        "You can save up to 1 gradient. Delete one to add another."
    );

    assert_eq!(
        tr::editor::crop::hint("\u{21e7}"),
        "Drag to move \u{b7} Arrow keys nudge \u{b7} Hold \u{21e7} to skip snapping"
    );
    assert_eq!(
        crate::editor_crop::crop_hint_parts(),
        (
            "Drag to move · Arrow keys nudge · Hold".to_string(),
            "to skip snapping".to_string()
        )
    );
}
