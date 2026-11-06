//! The macOS status-bar item -- `apps/desktop/src-tauri/src/tray.rs`.
//!
//! The pinned gpui exposes no status-item API at all (nothing in
//! `crates/gpui/src` mentions `NSStatusBar`, `NSStatusItem` or a tray of any
//! kind), so this is built directly on AppKit, the way `platform.rs` builds
//! the colour panel and the open panel.
//!
//! **The threading rule is the whole design.** An NSMenu item's action fires
//! from inside AppKit's *menu-tracking* run loop, a nested loop that runs while
//! the menu is open. Nothing there may touch gpui state: the App RefCell is
//! whatever the interrupted turn left it as. So the ObjC target does exactly
//! one thing -- push the clicked item's tag into a channel -- and a gpui
//! foreground task drains that channel and dispatches with a clean borrow.
//! Same seam the editor's overlay panels use for AppKit callbacks.
//!
//! Labels mirror `build_tray_menu`, except on macOS where the mode group
//! names the current mode and its section header follows the palette's
//! highlight in italic; the grouping is [`build_menu`]'s own.
//! "Upload Logs" renders disabled because the log-upload path does not exist
//! here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use global_hotkey::hotkey::{Code, HotKey, Modifiers};
use gpui::{App, Global};

use crate::{
    app_windows,
    hotkeys::{self, HotkeyAction},
    i18n::tr,
    library::{self, MediaKind},
    main_window::{Mode, TargetType},
    menus,
    settings_window::Page,
};

/// `MAX_PREVIOUS_ITEMS`.
const MAX_PREVIOUS_ITEMS: usize = 6;
/// `MAX_TITLE_LENGTH`.
const MAX_TITLE_LENGTH: usize = 30;
/// `THUMBNAIL_SIZE`.
const THUMBNAIL_SIZE: u32 = 32;

/// `get_mode_icon(mode)`. Template images (`icon_as_template(true)`), so macOS
/// tints them for the current menu-bar appearance.
#[cfg(target_os = "macos")]
fn mode_icon(mode: Mode) -> &'static [u8] {
    match mode {
        Mode::Studio => include_bytes!("../assets/tray/tray-default-icon-studio.png"),
        Mode::Instant => include_bytes!("../assets/tray/tray-default-icon-instant.png"),
        Mode::Screenshot => include_bytes!("../assets/tray/tray-default-icon-screenshot.png"),
    }
}

/// `set_tray_stop_icon`.
#[cfg(target_os = "macos")]
const STOP_ICON: &[u8] = include_bytes!("../assets/tray/tray-stop-icon.png");

// ---------------------------------------------------------------------------
// The menu model -- pure, so it can be built and asserted without AppKit
// ---------------------------------------------------------------------------

/// `TrayItem`, minus the four ids this app has no handler for (those items are
/// rendered disabled rather than given an id that would do nothing).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrayItem {
    OpenCap,
    RecordDisplay,
    RecordWindow,
    RecordArea,
    TakeScreenshot,
    ScreenshotDisplay,
    ScreenshotWindow,
    ScreenshotArea,
    ImportMedia,
    ViewAllRecordings,
    ViewAllScreenshots,
    OpenSettings,
    RequestPermissions,
    Quit,
    PreviousItem(PathBuf),
    ModeStudio,
    ModeInstant,
    ModeScreenshot,
}

/// A global hotkey as the menu renders it: the NSMenuItem key equivalent on
/// macOS, a `muda` accelerator on Windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Accelerator {
    pub modifiers: Modifiers,
    pub code: Code,
}

impl From<HotKey> for Accelerator {
    fn from(hotkey: HotKey) -> Self {
        Self {
            modifiers: hotkey.mods,
            code: hotkey.key,
        }
    }
}

/// One row of the menu.
#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    Separator,
    ModePicker {
        mode: Mode,
    },
    Item {
        title: String,
        item: Option<TrayItem>,
        enabled: bool,
        /// The row's image: a cover-cropped 32x32 photo thumbnail for
        /// Previous, a rasterised vector glyph anywhere else. `IconMenuItem`'s
        /// image -- Windows draws it; macOS draws `row_symbol`'s SF Symbol
        /// instead (photos aside).
        icon: Option<Vec<u8>>,
        /// The row's global shortcut, if one is registered for its action.
        accelerator: Option<Accelerator>,
    },
    Submenu {
        title: String,
        enabled: bool,
        items: Vec<Entry>,
        /// The header's glyph, rasterised at [`ROW_ICON_SIZE`] -- the raster
        /// Windows draws; macOS draws `PREVIOUS_SYMBOL` instead.
        icon: Option<Vec<u8>>,
    },
    /// A non-interactive group label: an `NSMenu` section header on macOS 14+.
    SectionHeader {
        title: String,
    },
}

/// The glyphs the action rows carry, keyed for [`menu_icon`] -- the same files
/// their in-app counterparts use. macOS prefers `row_symbol` over these;
/// Windows draws them.
const ROW_ICON_SOURCES: &[(&str, &[u8])] = &[
    (
        "display",
        include_bytes!("../assets/icons/screen.svg") as &[u8],
    ),
    (
        "window",
        include_bytes!("../assets/icons/window.svg") as &[u8],
    ),
    ("area", include_bytes!("../assets/icons/area.svg") as &[u8]),
    (
        "screenshot",
        include_bytes!("../assets/icons/screenshot.svg") as &[u8],
    ),
    (
        "import",
        include_bytes!("../assets/icons/import.svg") as &[u8],
    ),
    (
        "settings",
        include_bytes!("../assets/icons/settings.svg") as &[u8],
    ),
    (
        "previous",
        include_bytes!("../assets/icons/clock.svg") as &[u8],
    ),
    (
        "mode-instant",
        include_bytes!("../assets/icons/instant.svg") as &[u8],
    ),
    (
        "mode-studio",
        include_bytes!("../assets/icons/film-cut.svg") as &[u8],
    ),
    (
        "mode-screenshot",
        include_bytes!("../assets/icons/screenshot.svg") as &[u8],
    ),
];

/// `Entry::Item`'s `icon` size, and the raster size of every row glyph.
const ROW_ICON_SIZE: u32 = 32;
/// The mode picker draws its icons at 17 points. Rasterise at exactly 2x so
/// the image maps 1:1 to device pixels on a Retina display.
const PICKER_ICON_SIZE: u32 = 34;

/// An SVG rendered to a `size`×`size` PNG, scaled to fit and centred -- the
/// conversion `cap_mode_icon_png` makes at 90 for the palette, shared with the
/// menu rows at [`ROW_ICON_SIZE`]. Only the alpha survives a template tint.
fn svg_icon_png(source: &[u8], size: u32) -> Option<Vec<u8>> {
    let tree = resvg::usvg::Tree::from_data(source, &resvg::usvg::Options::default()).ok()?;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size, size)?;
    let bounds = tree.size();
    let scale = (size as f32 / bounds.width()).min(size as f32 / bounds.height());
    let transform = resvg::tiny_skia::Transform::from_translate(
        (size as f32 - bounds.width() * scale) / 2.0,
        (size as f32 - bounds.height() * scale) / 2.0,
    )
    .pre_scale(scale, scale);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    pixmap.encode_png().ok()
}

/// A row glyph as a PNG, rasterised once: a menu rebuild is cheap, seven SVG
/// renders are not.
fn menu_icon(name: &str) -> Option<Vec<u8>> {
    static ICONS: LazyLock<HashMap<&'static str, Vec<u8>>> = LazyLock::new(|| {
        ROW_ICON_SOURCES
            .iter()
            .filter_map(|(name, svg)| Some((*name, svg_icon_png(svg, ROW_ICON_SIZE)?)))
            .collect()
    });
    ICONS.get(name).cloned()
}

fn mode_picker_icon(mode: Mode) -> Option<Vec<u8>> {
    let source = match mode {
        Mode::Instant => include_bytes!("../assets/icons/instant.svg") as &[u8],
        Mode::Studio => include_bytes!("../assets/icons/film-cut.svg") as &[u8],
        Mode::Screenshot => include_bytes!("../assets/icons/screenshot.svg") as &[u8],
    };
    svg_icon_png(source, PICKER_ICON_SIZE)
}

/// The SF Symbol the macOS menu draws for an action row, keyed by its action;
/// Windows renders [`Entry::Item`]'s raster instead. Rows outside this list
/// (the chrome rows, the mode rows of the pre-14 menu) stay bare on both.
#[cfg(target_os = "macos")]
fn row_symbol(item: &TrayItem) -> Option<&'static str> {
    let window_symbol = if objc2::available!(macos = 26.0) {
        "interface.window"
    } else {
        "macwindow"
    };
    match item {
        TrayItem::RecordDisplay | TrayItem::ScreenshotDisplay => Some("display"),
        TrayItem::RecordWindow | TrayItem::ScreenshotWindow => Some(window_symbol),
        TrayItem::RecordArea | TrayItem::ScreenshotArea => Some("rectangle.dashed"),
        TrayItem::TakeScreenshot => Some("camera.on.rectangle"),
        TrayItem::ImportMedia => Some("square.and.arrow.down"),
        TrayItem::OpenSettings => Some("gear"),
        _ => None,
    }
}

/// The Previous submenu's header glyph, macOS side.
#[cfg(target_os = "macos")]
const PREVIOUS_SYMBOL: &str = "clock.arrow.circlepath";

impl Entry {
    fn item(title: impl Into<String>, item: TrayItem) -> Self {
        Self::Item {
            title: title.into(),
            item: Some(item),
            enabled: true,
            icon: None,
            accelerator: None,
        }
    }

    fn icon_item(title: impl Into<String>, item: TrayItem, icon: &str) -> Self {
        Self::Item {
            title: title.into(),
            item: Some(item),
            enabled: true,
            icon: menu_icon(icon),
            accelerator: None,
        }
    }

    /// An item with no handler: present, greyed out. `MenuItem::with_id(..,
    /// false, ..)` is how `build_tray_menu` spells the version row.
    fn disabled(title: impl Into<String>) -> Self {
        Self::Item {
            title: title.into(),
            item: None,
            enabled: false,
            icon: None,
            accelerator: None,
        }
    }
}

/// One entry of the Previous submenu.
#[derive(Clone, Debug, PartialEq)]
pub struct PreviousItem {
    pub path: PathBuf,
    pub kind: MediaKind,
    pub pretty_name: String,
    /// The cover-cropped 32x32 thumbnail, PNG-encoded so the AppKit side is a
    /// single `NSImage initWithData:`.
    pub thumbnail: Option<Vec<u8>>,
}

/// `truncate_title`: at most 30 *characters*, with the 30th replaced by an
/// ellipsis. The byte index is taken through `char_indices` because the title
/// is arbitrary user text -- slicing at byte 29 of a Japanese file name would
/// panic.
pub fn truncate_title(title: &str) -> String {
    if title.chars().count() <= MAX_TITLE_LENGTH {
        return title.to_string();
    }
    let truncate_at = MAX_TITLE_LENGTH - 1;
    let byte_index = title
        .char_indices()
        .nth(truncate_at)
        .map(|(index, _)| index)
        .unwrap_or(title.len());
    format!("{}\u{2026}", &title[..byte_index])
}

/// The `🎬 ` / `⚡ ` / `📷 ` prefix `create_previous_submenu` puts in front of
/// every Previous title (trailing space included).
pub fn type_indicator(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Studio => "\u{1f3ac} ",
        MediaKind::Instant => "\u{26a1} ",
        MediaKind::Screenshot => "\u{1f4f7} ",
    }
}

/// `load_thumbnail_data`'s geometry: scale so the *smaller* side reaches
/// `size` (cover, not contain), then centre-crop to `size` x `size`.
///
/// Returned as `(scaled_w, scaled_h, x_offset, y_offset)` so the arithmetic can
/// be checked without decoding an image.
pub fn cover_crop_geometry(orig_w: u32, orig_h: u32, size: u32) -> (u32, u32, u32, u32) {
    let scale = (size as f32 / orig_w as f32).max(size as f32 / orig_h as f32);
    let scaled_w = (orig_w as f32 * scale).round() as u32;
    let scaled_h = (orig_h as f32 * scale).round() as u32;
    (
        scaled_w,
        scaled_h,
        scaled_w.saturating_sub(size) / 2,
        scaled_h.saturating_sub(size) / 2,
    )
}

/// `load_thumbnail_data`, ending in a PNG rather than raw RGBA -- muda hands
/// its icon to AppKit as a PNG too (`PlatformIcon::to_nsimage`), so this is the
/// same conversion one step earlier. An opaque source (a recording's JPEG, a
/// display or area screenshot's RGB PNG) starts from the Recents card
/// thumbnail cache instead of the native-resolution original. That cache is
/// itself JPEG and drops alpha, so a source that can carry alpha (a window
/// screenshot's rounded-corner RGBA PNG) still decodes directly.
fn load_thumbnail_png(path: &Path) -> Option<Vec<u8>> {
    use image::{GenericImageView, ImageEncoder, RgbaImage, imageops::FilterType};

    let cached = (!source_may_have_alpha(path))
        .then(|| library::thumbnail_rgba(path))
        .flatten();
    let img = match cached {
        Some(rgba) => image::DynamicImage::ImageRgba8(rgba),
        None => image::load_from_memory(&std::fs::read(path).ok()?).ok()?,
    };
    let (orig_w, orig_h) = img.dimensions();
    if orig_w == 0 || orig_h == 0 {
        return None;
    }
    let size = THUMBNAIL_SIZE;
    let (scaled_w, scaled_h, x_offset, y_offset) = cover_crop_geometry(orig_w, orig_h, size);

    let scaled = img.resize_exact(scaled_w, scaled_h, FilterType::Triangle);
    let mut result = RgbaImage::new(size, size);
    for y in 0..size {
        for x in 0..size {
            let src_x = x + x_offset;
            let src_y = y + y_offset;
            if src_x < scaled_w && src_y < scaled_h {
                result.put_pixel(x, y, scaled.get_pixel(src_x, src_y));
            }
        }
    }

    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(result.as_raw(), size, size, image::ExtendedColorType::Rgba8)
        .ok()?;
    Some(png)
}

/// Reads only the signature and, for a PNG, the header chunks: the color type
/// says whether the pixels can carry alpha without decoding any of them.
fn source_may_have_alpha(path: &Path) -> bool {
    use image::{ImageDecoder, ImageFormat, ImageReader};

    let Ok(reader) = ImageReader::open(path).and_then(ImageReader::with_guessed_format) else {
        return true;
    };
    match reader.format() {
        Some(ImageFormat::Jpeg) => false,
        Some(ImageFormat::Png) => reader
            .into_decoder()
            .ok()
            .is_none_or(|decoder| decoder.color_type().has_alpha()),
        _ => true,
    }
}

/// `load_all_previous_items` + the background thumbnail pass, in one call.
///
/// Reuses the library scan the main window's Recents runs on, so the two lists
/// can never disagree about what is in the library (and `CAP_GPUI_RECORDINGS_DIR`
/// redirects both). Two nuances inherited from that scan rather than from
/// `load_all_previous_items`: each kind is capped at `RECENT_MEDIA_LIMIT`
/// before the merge, and a screenshot sorts by its PNG's timestamp rather than
/// its directory's -- both only observable in a library with more than nine
/// items of one kind created out of order.
pub fn scan_previous(load_thumbnails: bool) -> Vec<PreviousItem> {
    library::recent_media()
        .into_iter()
        .take(MAX_PREVIOUS_ITEMS)
        .map(|item| PreviousItem {
            kind: item.kind,
            pretty_name: item.pretty_name,
            thumbnail: item
                .thumbnail
                .as_deref()
                .filter(|_| load_thumbnails)
                .and_then(load_thumbnail_png),
            path: item.bundle,
        })
        .collect()
}

/// `create_previous_submenu`.
fn previous_submenu(previous: &[PreviousItem]) -> Entry {
    if previous.is_empty() {
        return Entry::Submenu {
            title: tr::tray::previous().into(),
            enabled: false,
            icon: menu_icon("previous"),
            items: vec![Entry::disabled(tr::tray::no_recent_items())],
        };
    }
    Entry::Submenu {
        title: tr::tray::previous().into(),
        enabled: true,
        icon: menu_icon("previous"),
        items: previous
            .iter()
            .map(|item| Entry::Item {
                title: format!(
                    "{}{}",
                    type_indicator(item.kind),
                    truncate_title(&item.pretty_name)
                ),
                item: Some(TrayItem::PreviousItem(item.path.clone())),
                enabled: true,
                icon: item.thumbnail.clone(),
                accelerator: None,
            })
            .collect(),
    }
}

fn mode_name(mode: Mode) -> &'static str {
    match mode {
        Mode::Studio => tr::main::mode::name::studio(),
        Mode::Instant => tr::main::mode::name::instant(),
        Mode::Screenshot => tr::main::mode::name::screenshot(),
    }
}

fn mode_heading(mode: Mode) -> &'static str {
    match mode {
        Mode::Studio => tr::main::mode::header::studio(),
        Mode::Instant => tr::main::mode::header::instant(),
        Mode::Screenshot => tr::main::mode::header::screenshot(),
    }
}

/// `create_mode_submenu`: a `✓ ` prefix on the current mode and three spaces on
/// the others, so the labels stay aligned without a real check mark.
fn mode_submenu(mode: Mode) -> Entry {
    let label = |target: Mode, text: &str| {
        Entry::item(
            if mode == target {
                format!("\u{2713} {text}")
            } else {
                format!("   {text}")
            },
            match target {
                Mode::Studio => TrayItem::ModeStudio,
                Mode::Instant => TrayItem::ModeInstant,
                Mode::Screenshot => TrayItem::ModeScreenshot,
            },
        )
    };
    Entry::Submenu {
        title: tr::tray::select_mode().into(),
        enabled: true,
        icon: None,
        items: vec![
            label(Mode::Studio, tr::tray::mode::studio()),
            label(Mode::Instant, tr::tray::mode::instant()),
            label(Mode::Screenshot, tr::tray::mode::screenshot()),
        ],
    }
}

fn capture_title(target: TargetType, screenshot: bool) -> &'static str {
    match (target, screenshot) {
        (TargetType::Display, true) => tr::tray::screenshot_display(),
        (TargetType::Window, true) => tr::tray::screenshot_window(),
        (TargetType::Area, true) => tr::tray::screenshot_area(),
        (TargetType::Display, false) => tr::tray::record_display(),
        (TargetType::Window, false) => tr::tray::record_window(),
        (TargetType::Area, false) => tr::tray::record_area(),
        (TargetType::CameraOnly, _) => "",
    }
}

fn capture_icon(target: TargetType) -> &'static str {
    match target {
        TargetType::Display => "display",
        TargetType::Window => "window",
        TargetType::Area => "area",
        TargetType::CameraOnly => "display",
    }
}

fn capture_entry(target: TargetType, mode: Mode) -> Entry {
    let screenshot = mode == Mode::Screenshot;
    let (title, item) = match target {
        TargetType::Display => (
            if screenshot {
                tr::tray::screenshot_display()
            } else {
                tr::tray::record_display()
            },
            if screenshot {
                TrayItem::ScreenshotDisplay
            } else {
                TrayItem::RecordDisplay
            },
        ),
        TargetType::Window => (
            if screenshot {
                tr::tray::screenshot_window()
            } else {
                tr::tray::record_window()
            },
            if screenshot {
                TrayItem::ScreenshotWindow
            } else {
                TrayItem::RecordWindow
            },
        ),
        TargetType::Area => (
            if screenshot {
                tr::tray::screenshot_area()
            } else {
                tr::tray::record_area()
            },
            if screenshot {
                TrayItem::ScreenshotArea
            } else {
                TrayItem::RecordArea
            },
        ),
        TargetType::CameraOnly => unreachable!("capture slots are display, window and area"),
    };
    Entry::icon_item(title, item, capture_icon(target))
}

/// `build_tray_menu`, minus the onboarding-minimal branch.
pub fn build_menu(mode: Mode, previous: &[PreviousItem], version: &str) -> Vec<Entry> {
    let mut entries = Vec::new();

    entries.push(Entry::item(tr::tray::open_main_window(), TrayItem::OpenCap));
    entries.push(Entry::Separator);
    if cfg!(target_os = "macos") {
        entries.push(Entry::ModePicker { mode });
        entries.push(Entry::Separator);
    } else {
        entries.push(mode_submenu(mode));
        entries.push(Entry::Separator);
    }

    for target in [TargetType::Display, TargetType::Window, TargetType::Area] {
        entries.push(capture_entry(target, mode));
    }
    if mode != Mode::Screenshot {
        entries.push(Entry::icon_item(
            tr::tray::take_screenshot(),
            TrayItem::TakeScreenshot,
            "screenshot",
        ));
    }

    entries.push(Entry::Separator);
    entries.push(previous_submenu(previous));
    entries.push(Entry::item(
        tr::tray::view_all_recordings(),
        TrayItem::ViewAllRecordings,
    ));
    entries.push(Entry::item(
        tr::tray::view_all_screenshots(),
        TrayItem::ViewAllScreenshots,
    ));

    entries.push(Entry::Separator);
    entries.push(Entry::icon_item(
        tr::tray::import_media(),
        TrayItem::ImportMedia,
        "import",
    ));
    entries.push(Entry::icon_item(
        tr::tray::settings(),
        TrayItem::OpenSettings,
        "settings",
    ));
    // `logging::upload_log_file` needs the auth token and the HTTP client,
    // neither of which this app has.
    entries.push(Entry::disabled(tr::tray::upload_logs()));
    entries.push(Entry::Separator);

    if cfg!(target_os = "macos") {
        entries.push(Entry::item(tr::tray::quit(), TrayItem::Quit));
        entries.push(Entry::SectionHeader {
            title: tr::tray::version(version),
        });
    } else {
        entries.push(Entry::disabled(tr::tray::version(version)));
        entries.push(Entry::item(tr::tray::quit(), TrayItem::Quit));
    }

    entries
}

pub fn build_onboarding_menu(version: &str) -> Vec<Entry> {
    vec![
        Entry::item(
            tr::tray::request_permissions(),
            TrayItem::RequestPermissions,
        ),
        Entry::Separator,
        Entry::disabled(tr::tray::version(version)),
        Entry::item(tr::tray::quit(), TrayItem::Quit),
    ]
}

/// The hotkey that performs a capture row's action.
fn hotkey_action(item: &TrayItem) -> Option<HotkeyAction> {
    match item {
        TrayItem::RecordDisplay => Some(HotkeyAction::OpenRecordingPickerDisplay),
        TrayItem::RecordWindow => Some(HotkeyAction::OpenRecordingPickerWindow),
        TrayItem::RecordArea => Some(HotkeyAction::OpenRecordingPickerArea),
        TrayItem::TakeScreenshot | TrayItem::ScreenshotDisplay => {
            Some(HotkeyAction::ScreenshotDisplay)
        }
        TrayItem::ScreenshotWindow => Some(HotkeyAction::ScreenshotWindow),
        TrayItem::ScreenshotArea => Some(HotkeyAction::ScreenshotArea),
        _ => None,
    }
}

fn decorate_accelerators(entries: &mut [Entry], cx: &App) {
    for entry in entries {
        match entry {
            Entry::Item {
                item: Some(item),
                accelerator,
                ..
            } => {
                *accelerator = hotkey_action(item)
                    .and_then(|action| hotkeys::accelerator(action, cx))
                    .map(Into::into);
            }
            Entry::Submenu { items, .. } => decorate_accelerators(items, cx),
            _ => {}
        }
    }
}

fn current_menu_entries(cx: &App, mode: Mode, previous: &[PreviousItem]) -> Vec<Entry> {
    if crate::app_windows::onboarding_is_open(cx) && !crate::permissions::necessary_granted() {
        return build_onboarding_menu(crate::menus::app_version());
    }
    let mut entries = build_menu(mode, previous, crate::menus::app_version());
    decorate_accelerators(&mut entries, cx);
    entries
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Act on a tray item, with a clean gpui borrow. Public so the harness hook can
/// reach exactly the path a click reaches.
pub fn handle_item(item: TrayItem, cx: &mut App) {
    tracing::info!(?item, "tray item activated");
    match item {
        TrayItem::OpenCap => {
            app_windows::show_main_window(cx);
            // The status item is clickable while the app is inactive; an
            // Accessory app that just went Regular still needs activating for
            // the window (and the menu bar) to come forward.
            cx.activate(true);
        }
        TrayItem::RecordDisplay => record_target(TargetType::Display, cx),
        TrayItem::RecordWindow => record_target(TargetType::Window, cx),
        TrayItem::RecordArea => record_target(TargetType::Area, cx),
        // `TrayItem::TakeScreenshot` captures the display under the cursor,
        // primary as the fallback (`tray.rs:816` over there).
        TrayItem::TakeScreenshot | TrayItem::ScreenshotDisplay => take_display_screenshot(cx),
        TrayItem::ScreenshotWindow => {
            set_mode(Mode::Screenshot, cx);
            app_windows::arm_target_mode(TargetType::Window, cx);
        }
        TrayItem::ScreenshotArea => {
            set_mode(Mode::Screenshot, cx);
            app_windows::arm_target_mode(TargetType::Area, cx);
        }
        // `TrayItem::ImportVideo` (`src-tauri/src/tray.rs:839-911`): one
        // picker over both media filters, routed by extension.
        TrayItem::ImportMedia => crate::import::pick_and_import_media(cx),
        TrayItem::ViewAllRecordings => {
            app_windows::open_settings(Page::Recordings, cx);
            cx.activate(true);
        }
        TrayItem::ViewAllScreenshots => {
            app_windows::open_settings(Page::Screenshots, cx);
            cx.activate(true);
        }
        TrayItem::OpenSettings => {
            app_windows::open_settings(Page::General, cx);
            cx.activate(true);
        }
        TrayItem::RequestPermissions => {
            app_windows::open_onboarding(cx);
            cx.activate(true);
        }
        TrayItem::Quit => menus::quit(cx),
        TrayItem::PreviousItem(path) => open_previous_item(path, cx),
        TrayItem::ModeStudio => set_mode(Mode::Studio, cx),
        TrayItem::ModeInstant => set_mode(Mode::Instant, cx),
        TrayItem::ModeScreenshot => set_mode(Mode::Screenshot, cx),
    }
}

fn record_target(target: TargetType, cx: &mut App) {
    if Mode::from_store() == Mode::Screenshot {
        set_mode(Mode::Studio, cx);
    }
    app_windows::arm_target_mode(target, cx);
}

fn take_display_screenshot(cx: &mut App) {
    let display = scap_targets::Display::get_containing_cursor()
        .unwrap_or_else(scap_targets::Display::primary);
    crate::screenshot::take_screenshot(
        cap_recording::sources::screen_capture::ScreenCaptureTarget::Display { id: display.id() },
        cx,
    );
}

/// `handle_mode_selection`: persist, swap the icon, rebuild the menu. All three
/// live in `MainWindow::set_mode` here, which every mode affordance funnels
/// through, so this is `app_windows::set_recording_mode` and nothing else.
fn set_mode(mode: Mode, cx: &mut App) {
    app_windows::set_recording_mode(mode, cx);
    // `MainWindow::set_mode` short-circuits when the mode is unchanged, so
    // refresh here too: the tray must end up consistent whichever way it got
    // there.
    mode_changed(mode, cx);
}

/// `handle_previous_item_click`.
pub(crate) fn open_previous_item(path: PathBuf, cx: &mut App) {
    use cap_project::{RecordingMeta, RecordingMetaInner};

    let screenshots_dir = library::screenshots_dir();
    let is_screenshot = (path.extension().and_then(|ext| ext.to_str()) == Some("cap")
        && path
            .parent()
            .map(|parent| parent == screenshots_dir)
            .unwrap_or(false))
        || library::is_screenshot_bundle(&path);

    if is_screenshot {
        app_windows::open_screenshot_editor(path, cx);
        cx.activate(true);
        return;
    }

    let meta = match RecordingMeta::load_for_project(&path) {
        Ok(meta) => meta,
        Err(error) => {
            tracing::error!("Failed to load recording meta for previous item: {error}");
            return;
        }
    };

    match &meta.inner {
        RecordingMetaInner::Studio(_) => {
            app_windows::open_editor(path, cx);
            cx.activate(true);
        }
        RecordingMetaInner::Instant(_) => {
            if let Some(sharing) = &meta.sharing {
                cx.open_url(&sharing.link);
            } else {
                let mp4 = path.join("content/output.mp4");
                if mp4.exists() {
                    library::open_with_system(&mp4, cx);
                }
            }
        }
    }
}

/// The status item was clicked while a recording is running: stop it, exactly
/// as `on_tray_icon_event` does.
fn stop_recording(cx: &mut App) {
    let session = crate::session::RecordingSession::global(cx);
    session.update(cx, |session, cx| session.stop(cx));
}

// ---------------------------------------------------------------------------
// Verification hooks
// ---------------------------------------------------------------------------

/// A flat, greppable rendering of the menu -- what the verification run diffs
/// against `build_tray_menu`. Submenu rows are indented two spaces; a disabled
/// row is suffixed with ` [disabled]`; a row with an image with ` [icon]`;
/// a section header with ` [section]`.
pub fn describe_menu(entries: &[Entry]) -> String {
    fn walk(entries: &[Entry], depth: usize, out: &mut String) {
        for entry in entries {
            let pad = "  ".repeat(depth);
            match entry {
                Entry::Separator => out.push_str(&format!("{pad}---\n")),
                Entry::ModePicker { mode } => {
                    out.push_str(&format!("{pad}{}\n", mode_name(*mode)));
                    for name in ["Studio", "Instant", "Screenshot"] {
                        out.push_str(&format!("{}{name}\n", "  ".repeat(depth + 1)));
                    }
                }
                Entry::SectionHeader { title } => {
                    out.push_str(&format!("{pad}{title} [section]\n"));
                }
                Entry::Item {
                    title,
                    enabled,
                    icon,
                    ..
                } => out.push_str(&format!(
                    "{pad}{title}{}{}\n",
                    if *enabled { "" } else { " [disabled]" },
                    if icon.is_some() { " [icon]" } else { "" }
                )),
                Entry::Submenu {
                    title,
                    enabled,
                    items,
                    icon,
                } => {
                    out.push_str(&format!(
                        "{pad}{title}{}{}\n",
                        if *enabled { "" } else { " [disabled]" },
                        if icon.is_some() { " [icon]" } else { "" }
                    ));
                    walk(items, depth + 1, out);
                }
            }
        }
    }
    let mut out = String::new();
    walk(entries, 0, &mut out);
    out
}

/// `CAP_GPUI_AUTO_TRAY=<spec>` picks a menu row and activates it through
/// [`handle_item`] -- the exact function the ObjC action's channel drain calls,
/// so the harness path and the click path are one path. It exists for the same
/// reason as every other `CAP_GPUI_AUTO_*` hook: unprivileged synthetic clicks
/// are dropped, and a status-item menu is a nested tracking run loop on top of
/// that.
///
/// `CAP_GPUI_TRAY_DUMP=<path>` writes [`describe_menu`] of the live menu.
pub fn drive_from_env(cx: &mut App) {
    let spec = std::env::var("CAP_GPUI_AUTO_TRAY")
        .ok()
        .filter(|s| !s.is_empty());
    let dump = std::env::var("CAP_GPUI_TRAY_DUMP")
        .ok()
        .filter(|s| !s.is_empty());
    let delay_ms = std::env::var("CAP_GPUI_AUTO_TRAY_DELAY")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(3000);
    if spec.is_none() && dump.is_none() {
        return;
    }

    cx.spawn(async move |cx| {
        // The Previous submenu is filled by a background scan; wait for it or
        // the dump would show an empty one and `previous:N` would find nothing.
        cx.background_executor()
            .timer(std::time::Duration::from_millis(delay_ms))
            .await;
        cx.update(|cx| {
            if let Some(path) = dump {
                let text = describe_menu(&menu_snapshot(cx));
                tracing::info!(path, "writing the tray menu dump");
                if let Err(error) = std::fs::write(&path, text) {
                    tracing::error!("tray menu dump failed: {error}");
                }
            }
            let Some(spec) = spec else { return };
            for spec in spec.split(';').filter(|spec| !spec.is_empty()) {
                match harness_item(spec, cx) {
                    Some(item) => handle_item(item, cx),
                    None if spec == "stop" => stop_recording(cx),
                    None => tracing::error!(spec, "CAP_GPUI_AUTO_TRAY: unknown item"),
                }
            }
        });
    })
    .detach();
}

fn harness_item(spec: &str, cx: &App) -> Option<TrayItem> {
    if let Some(index) = spec.strip_prefix("previous:") {
        let index: usize = index.parse().ok()?;
        let item = previous_items(cx).into_iter().nth(index)?;
        return Some(TrayItem::PreviousItem(item.path));
    }
    Some(match spec {
        "open_main" => TrayItem::OpenCap,
        "record_display" => TrayItem::RecordDisplay,
        "record_window" => TrayItem::RecordWindow,
        "record_area" => TrayItem::RecordArea,
        "import_media" => TrayItem::ImportMedia,
        "recordings" => TrayItem::ViewAllRecordings,
        "screenshots" => TrayItem::ViewAllScreenshots,
        "settings" => TrayItem::OpenSettings,
        "quit" => TrayItem::Quit,
        "mode_studio" => TrayItem::ModeStudio,
        "mode_instant" => TrayItem::ModeInstant,
        "mode_screenshot" => TrayItem::ModeScreenshot,
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// The AppKit status item
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
pub use mac::*;

#[cfg(target_os = "macos")]
mod mac_mode_picker;

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::{Cell, RefCell};

    use std::ptr::NonNull;

    use gpui::{App, Global};
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject, Sel};
    use objc2::{AnyThread, MainThreadOnly, define_class, msg_send, sel};
    use objc2_app_kit::{
        NSEvent, NSEventModifierFlags, NSEventTrackingRunLoopMode, NSImage, NSMenu, NSMenuDelegate,
        NSMenuItem, NSStatusBar, NSStatusBarButton, NSStatusItem,
    };
    use objc2_foundation::{MainThreadMarker, NSData, NSRunLoop, NSString, NSTimer};

    use super::mac_mode_picker::{
        append_mode_picker, clear_hover, clear_hover_unless, fit_to_menu_width, hover_from_pointer,
        install_key_hook, stop_flash,
    };
    use super::{
        Accelerator, Entry, PREVIOUS_SYMBOL, PreviousItem, STOP_ICON, TrayItem,
        current_menu_entries, handle_item, mode_icon, mode_submenu, row_symbol, scan_previous,
        stop_recording,
    };
    use crate::main_window::{Mode, TargetType};

    /// `NSVariableStatusItemLength`.
    const NS_VARIABLE_STATUS_ITEM_LENGTH: f64 = -1.0;
    /// The point height tray-icon and muda both scale a status-item image and a
    /// menu-item icon to.
    const ICON_HEIGHT: f64 = 18.0;
    /// Not a menu item: the status button itself, clicked mid-recording.
    const STOP_TAG: isize = -1;
    const REBUILD_TAG: isize = -2;

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Intent {
        Record,
        Screenshot,
    }

    /// One capture row, with both actions registered up front. A mode or
    /// Option change only retargets the tag; the menu is never rebuilt while
    /// it is open.
    struct ActionRow {
        item: Retained<NSMenuItem>,
        target: TargetType,
        record_item: TrayItem,
        screenshot_item: TrayItem,
        record_tag: isize,
        screenshot_tag: isize,
        record_accelerator: Option<Accelerator>,
        screenshot_accelerator: Option<Accelerator>,
    }

    thread_local! {
        static TRAY_TX: RefCell<Option<flume::Sender<isize>>> = const { RefCell::new(None) };
        static MENU_OPEN: Cell<bool> = const { Cell::new(false) };
        static REBUILD_PENDING: Cell<bool> = const { Cell::new(false) };
        static OPTION_TIMER: RefCell<Option<Retained<NSTimer>>> = const { RefCell::new(None) };
        static OPTION_HELD: Cell<bool> = const { Cell::new(false) };
        static CURRENT_MODE: Cell<Option<Mode>> = const { Cell::new(None) };
        static ROWS: RefCell<Vec<ActionRow>> = const { RefCell::new(Vec::new()) };
        static STATUS_ITEM: RefCell<Option<Retained<NSStatusItem>>> = const { RefCell::new(None) };
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements; this class has no ivars or Drop.
        #[unsafe(super(objc2::runtime::NSObject))]
        #[name = "CapGpuiTrayTarget"]
        #[thread_kind = MainThreadOnly]
        struct TrayTarget;

        impl TrayTarget {
            /// Fires inside AppKit's menu-tracking run loop. Touching gpui here
            /// is what "RefCell already borrowed" looks like, so it only posts
            /// the tag.
            #[unsafe(method(capTrayItem:))]
            fn tray_item(&self, sender: &NSMenuItem) {
                post(sender.tag());
            }

            #[unsafe(method(capTrayMode:))]
            fn tray_mode(&self, sender: &NSMenuItem) {
                post(sender.tag());
            }

            /// The status button's action while a recording is running.
            #[unsafe(method(capTrayStop:))]
            fn tray_stop(&self, _sender: &NSStatusBarButton) {
                post(STOP_TAG);
            }
        }

        unsafe impl NSObjectProtocol for TrayTarget {}

        unsafe impl NSMenuDelegate for TrayTarget {
            #[unsafe(method(menu:willHighlightItem:))]
            fn menu_will_highlight_item(&self, _menu: &NSMenu, item: Option<&NSMenuItem>) {
                clear_hover_unless(item);
            }

            #[unsafe(method(menuWillOpen:))]
            fn menu_will_open(&self, menu: &NSMenu) {
                MENU_OPEN.with(|o| o.set(true));
                fit_to_menu_width(menu.size().width);
                clear_hover();
                hover_from_pointer();
                start_option_tracking();
            }

            #[unsafe(method(menuDidClose:))]
            fn menu_did_close(&self, _menu: &NSMenu) {
                MENU_OPEN.with(|o| o.set(false));
                clear_hover();
                stop_option_tracking();
                stop_flash();
                if REBUILD_PENDING.with(|p| p.replace(false)) {
                    post(REBUILD_TAG);
                }
            }
        }
    );

    pub(super) fn post(tag: isize) {
        TRAY_TX.with(|tx| {
            if let Some(sender) = tx.borrow().as_ref() {
                let _ = sender.send(tag);
            }
        });
    }

    struct Tray {
        status_item: Retained<NSStatusItem>,
        target: Retained<TrayTarget>,
        /// Retained so the menu can be detached (recording) and reattached
        /// (stopped) without rebuilding it.
        menu: Option<Retained<NSMenu>>,
        /// Tag -> item, rebuilt with the menu. The index *is* the tag.
        actions: Vec<TrayItem>,
        mode: Mode,
        previous: Vec<PreviousItem>,
        previous_generation: u64,
        recording: bool,
    }

    impl Global for Tray {}

    /// Install the status item. Called once from `main`, after the window
    /// registry exists -- every handler reaches into it.
    pub fn init(cx: &mut App) {
        let Some(tray) = create_status_item() else {
            tracing::error!("no NSStatusItem; the tray is not available");
            return;
        };
        cx.set_global(tray);
        install_key_hook();

        let (tx, rx) = flume::unbounded::<isize>();
        TRAY_TX.with(|slot| *slot.borrow_mut() = Some(tx));

        // The drain. One task for the life of the process: every tray click
        // arrives here, on the foreground executor, with nothing borrowed.
        cx.spawn(async move |cx| {
            while let Ok(tag) = rx.recv_async().await {
                cx.update(|cx| {
                    match tag {
                        STOP_TAG => {
                            stop_recording(cx);
                            return;
                        }
                        REBUILD_TAG => {
                            rebuild(cx);
                            return;
                        }
                        _ => {}
                    }
                    let item = cx.global::<Tray>().actions.get(tag as usize).cloned();
                    match item {
                        Some(item) => handle_item(item, cx),
                        None => tracing::warn!(tag, "tray click with no item behind it"),
                    }
                });
            }
        })
        .detach();

        rebuild(cx);

        // `create_tray`'s background thumbnail pass: the menu is up immediately
        // with no Previous items, and the library scan (plus six image decodes)
        // replaces it when it lands.
        cx.spawn(async move |cx| {
            let previous = cx
                .background_executor()
                .spawn(async { scan_previous(true) })
                .await;
            cx.update(|cx| {
                cx.global_mut::<Tray>().previous = previous;
                rebuild(cx);
            });
        })
        .detach();
    }

    fn create_status_item() -> Option<Tray> {
        let mtm = MainThreadMarker::new()?;
        let status_item =
            NSStatusBar::systemStatusBar().statusItemWithLength(NS_VARIABLE_STATUS_ITEM_LENGTH);
        let target: Retained<TrayTarget> = unsafe { msg_send![TrayTarget::alloc(mtm), init] };

        let mode = Mode::from_store();
        let tray = Tray {
            status_item,
            target,
            menu: None,
            actions: Vec::new(),
            mode,
            previous: Vec::new(),
            previous_generation: 0,
            recording: false,
        };
        set_button_image(&tray, mode_icon(mode));
        let button = tray.status_item.button(mtm);
        let frame = button.as_ref().map_or_else(
            || {
                objc2_foundation::NSRect::new(
                    objc2_foundation::NSPoint::new(0.0, 0.0),
                    objc2_foundation::NSSize::new(0.0, 0.0),
                )
            },
            |button| button.frame(),
        );

        tracing::info!(
            has_button = button.is_some(),
            visible = tray.status_item.isVisible(),
            width = frame.size.width,
            height = frame.size.height,
            ?mode,
            "status item created"
        );
        Some(tray)
    }

    /// `set_icon_for_ns_status_item_button`: an 18pt-tall template image on the
    /// status item's button.
    fn set_button_image(tray: &Tray, png: &[u8]) {
        set_status_item_image(&tray.status_item, png);
    }

    pub(super) fn set_status_mode(mode: Mode) {
        STATUS_ITEM.with(|slot| {
            if let Some(status_item) = slot.borrow().as_ref() {
                set_status_item_image(status_item, mode_icon(mode));
            }
        });
    }

    fn set_status_item_image(status_item: &NSStatusItem, png: &[u8]) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(button) = status_item.button(mtm) else {
            return;
        };
        let Some(image) = ns_image(png, ICON_HEIGHT) else {
            return;
        };
        button.setImage(Some(&image));
        image.setTemplate(true);
        tracing::info!(
            icon = icon_name(png),
            bytes = png.len(),
            "status item icon set"
        );
    }

    fn icon_name(png: &[u8]) -> &'static str {
        if std::ptr::eq(png.as_ptr(), STOP_ICON.as_ptr()) {
            return "stop";
        }
        for mode in [Mode::Studio, Mode::Instant, Mode::Screenshot] {
            if std::ptr::eq(png.as_ptr(), mode_icon(mode).as_ptr()) {
                return match mode {
                    Mode::Studio => "studio",
                    Mode::Instant => "instant",
                    Mode::Screenshot => "screenshot",
                };
            }
        }
        "unknown"
    }

    /// An `NSImage` from PNG bytes, scaled to `height` points with its aspect
    /// preserved -- the conversion muda and tray-icon both do.
    fn ns_image(bytes: &[u8], height: f64) -> Option<Retained<NSImage>> {
        let data = NSData::with_bytes(bytes);
        let image = NSImage::initWithData(NSImage::alloc(), &data)?;
        let size = image.size();
        if size.height > 0.0 {
            image.setSize(objc2_foundation::NSSize::new(
                size.width / (size.height / height),
                height,
            ));
        }
        Some(image)
    }

    /// An SF Symbol at the size the system serves it (15-20pt, the range menu
    /// icons live in) -- already a template image. The API only exists on
    /// macOS 11+, and an unknown name comes back nil; both cases leave the
    /// row bare rather than falling back to the raster, which Windows owns.
    pub(super) fn symbol_image(name: &str) -> Option<Retained<NSImage>> {
        if !objc2::available!(macos = 11.0) {
            return None;
        }
        NSImage::imageWithSystemSymbolName_accessibilityDescription(&NSString::from_str(name), None)
    }

    /// Rebuild the menu from the current mode and Previous cache, and attach it
    /// (unless a recording is running, in which case the *button* owns the
    /// click -- see [`set_recording`]). While the menu is open the rows are
    /// retargeted in place instead; the menu is only rebuilt once it closes.
    pub fn rebuild(cx: &mut App) {
        if MENU_OPEN.with(Cell::get) {
            REBUILD_PENDING.with(|p| p.set(true));
            return;
        }
        if !cx.has_global::<Tray>() {
            return;
        }
        let (mode, previous, target) = {
            let tray = cx.global::<Tray>();
            (tray.mode, tray.previous.clone(), tray.target.clone())
        };
        let entries = current_menu_entries(cx, mode, &previous);
        let mut actions = Vec::new();
        let menu = build_ns_menu(&entries, &target, &mut actions, cx);
        menu.setDelegate(Some(ProtocolObject::from_ref(&*target)));

        let tray = cx.global::<Tray>();
        if !tray.recording {
            tray.status_item.setMenu(Some(&menu));
        }

        let tray = cx.global_mut::<Tray>();
        tray.actions = actions;
        tray.menu = Some(menu);
        apply(mode, current_option());
    }

    fn build_ns_menu(
        entries: &[Entry],
        target: &TrayTarget,
        actions: &mut Vec<TrayItem>,
        cx: &App,
    ) -> Retained<NSMenu> {
        let mtm =
            MainThreadMarker::new().expect("tray menu construction must run on the main thread");
        let menu = NSMenu::new(mtm);
        menu.setAutoenablesItems(false);
        fill_ns_menu(&menu, entries, target, actions, cx);
        menu
    }

    fn fill_ns_menu(
        menu: &NSMenu,
        entries: &[Entry],
        target: &TrayTarget,
        actions: &mut Vec<TrayItem>,
        cx: &App,
    ) {
        let mtm =
            MainThreadMarker::new().expect("tray menu construction must run on the main thread");
        menu.removeAllItems();
        ROWS.with(|rows| rows.borrow_mut().clear());

        for entry in entries {
            if let Entry::ModePicker { mode } = entry {
                if objc2::available!(macos = 14.0) {
                    append_mode_picker(menu, *mode, actions, mtm);
                } else {
                    let submenu = mode_submenu(*mode);
                    menu.addItem(&build_ns_item(&submenu, target, actions, mtm));
                }
                continue;
            }

            if let Entry::Item {
                title,
                item: Some(tray_item),
                enabled,
                ..
            } = entry
                && let Some((target_type, record_item, screenshot_item)) = capture_pair(tray_item)
            {
                let menu_item = new_menu_item(title, Some(sel!(capTrayItem:)), mtm);
                unsafe { menu_item.setTarget(Some(target)) };
                menu_item.setEnabled(*enabled);
                let record_tag = actions.len() as isize;
                actions.push(record_item.clone());
                let screenshot_tag = actions.len() as isize;
                actions.push(screenshot_item.clone());
                let record_accelerator = accelerator_for(&record_item, cx);
                let screenshot_accelerator = accelerator_for(&screenshot_item, cx);
                ROWS.with(|rows| {
                    rows.borrow_mut().push(ActionRow {
                        item: menu_item.clone(),
                        target: target_type,
                        record_item,
                        screenshot_item,
                        record_tag,
                        screenshot_tag,
                        record_accelerator,
                        screenshot_accelerator,
                    });
                });
                menu.addItem(&menu_item);
                continue;
            }

            let menu_item = build_ns_item(entry, target, actions, mtm);
            menu.addItem(&menu_item);
        }
    }

    fn capture_pair(item: &TrayItem) -> Option<(TargetType, TrayItem, TrayItem)> {
        match item {
            TrayItem::RecordDisplay | TrayItem::ScreenshotDisplay => Some((
                TargetType::Display,
                TrayItem::RecordDisplay,
                TrayItem::ScreenshotDisplay,
            )),
            TrayItem::RecordWindow | TrayItem::ScreenshotWindow => Some((
                TargetType::Window,
                TrayItem::RecordWindow,
                TrayItem::ScreenshotWindow,
            )),
            TrayItem::RecordArea | TrayItem::ScreenshotArea => Some((
                TargetType::Area,
                TrayItem::RecordArea,
                TrayItem::ScreenshotArea,
            )),
            _ => None,
        }
    }

    fn accelerator_for(item: &TrayItem, cx: &App) -> Option<Accelerator> {
        super::hotkey_action(item)
            .and_then(|action| crate::hotkeys::accelerator(action, cx))
            .map(Into::into)
    }

    fn intent_for(mode: Mode, option: bool) -> Intent {
        match (mode == Mode::Screenshot, option) {
            (false, false) | (true, true) => Intent::Record,
            (false, true) | (true, false) => Intent::Screenshot,
        }
    }

    pub(super) fn current_option() -> bool {
        NSEvent::modifierFlags_class().contains(NSEventModifierFlags::Option)
    }

    /// Retarget the four capture rows for `mode` and the Option key. Both
    /// actions are already in `Tray::actions`, so swapping is only a tag
    /// change. Native AppKit alternate items pair on a shared key equivalent
    /// and different modifier masks; these rows need a different accelerator
    /// per intent, so they cannot be a native pair.
    pub(super) fn apply(mode: Mode, option: bool) {
        CURRENT_MODE.set(Some(mode));
        let intent = intent_for(mode, option);
        ROWS.with(|rows| {
            let rows = rows.borrow();
            for row in rows.iter() {
                let (title, item, tag, accelerator) = match intent {
                    Intent::Record => (
                        super::capture_title(row.target, false),
                        &row.record_item,
                        row.record_tag,
                        row.record_accelerator,
                    ),
                    Intent::Screenshot => (
                        super::capture_title(row.target, true),
                        &row.screenshot_item,
                        row.screenshot_tag,
                        row.screenshot_accelerator,
                    ),
                };
                row.item.setTitle(&NSString::from_str(title));
                row.item.setTag(tag);
                set_key_equivalent(&row.item, accelerator);
                set_row_image(&row.item, item);
            }
        });
    }

    fn set_key_equivalent(item: &NSMenuItem, accelerator: Option<Accelerator>) {
        item.setKeyEquivalent(&NSString::from_str(""));
        item.setKeyEquivalentModifierMask(NSEventModifierFlags::empty());
        if let Some(accelerator) = accelerator
            && let Some(key) = key_equivalent(accelerator.code)
        {
            item.setKeyEquivalent(&NSString::from_str(&key));
            item.setKeyEquivalentModifierMask(modifier_flags(accelerator.modifiers));
        }
    }

    fn set_row_image(item: &NSMenuItem, tray_item: &TrayItem) {
        let Some(symbol) = row_symbol(tray_item) else {
            return;
        };
        let Some(image) = symbol_image(symbol) else {
            tracing::warn!(symbol, "SF Symbol not resolved");
            return;
        };
        image.setTemplate(true);
        item.setImage(Some(&image));
        crate::platform::set_nsmenu_item_prefers_visible_image(item);
    }

    pub(super) fn start_option_tracking() {
        // Sync to the real modifier state first; the rows may have been stamped
        // by a rebuild that ran while Option was still held.
        let held = current_option();
        OPTION_HELD.set(held);
        if let Some(mode) = CURRENT_MODE.get() {
            apply(mode, held);
        }

        OPTION_TIMER.with(|slot| {
            if slot.borrow().is_some() {
                return;
            }
            let block = block2::RcBlock::new(|_timer: NonNull<NSTimer>| {
                let held = current_option();
                if OPTION_HELD.replace(held) != held
                    && let Some(mode) = CURRENT_MODE.get()
                {
                    apply(mode, held);
                    refit_picker_to_menu();
                }
            });
            let timer = unsafe { NSTimer::timerWithTimeInterval_repeats_block(0.05, true, &block) };
            let run_loop = NSRunLoop::currentRunLoop();
            unsafe {
                run_loop.addTimer_forMode(&timer, NSEventTrackingRunLoopMode);
            }
            *slot.borrow_mut() = Some(timer);
        });
    }

    pub(super) fn refit_picker_to_menu() {
        ROWS.with(|rows| {
            let rows = rows.borrow();
            let Some(row) = rows.first() else {
                return;
            };
            let Some(menu) = (unsafe { row.item.menu() }) else {
                return;
            };
            menu.update();
            super::mac_mode_picker::fit_to_menu_width(menu.size().width);
        });
    }

    pub(super) fn stop_option_tracking() {
        OPTION_TIMER.with(|slot| {
            if let Some(timer) = slot.borrow_mut().take() {
                timer.invalidate();
            }
        });
        OPTION_HELD.set(false);
    }

    fn build_ns_item(
        entry: &Entry,
        target: &TrayTarget,
        actions: &mut Vec<TrayItem>,
        mtm: MainThreadMarker,
    ) -> Retained<NSMenuItem> {
        match entry {
            Entry::Separator => NSMenuItem::separatorItem(mtm),
            Entry::ModePicker { mode } => {
                let submenu = mode_submenu(*mode);
                build_ns_item(&submenu, target, actions, mtm)
            }
            Entry::Item {
                title,
                item,
                enabled,
                icon,
                accelerator,
                ..
            } => {
                let menu_item = new_menu_item(title, Some(sel!(capTrayItem:)), mtm);
                unsafe { menu_item.setTarget(Some(target)) };
                menu_item.setEnabled(*enabled && item.is_some());
                if let Some(item) = item {
                    menu_item.setTag(actions.len() as isize);
                    actions.push(item.clone());
                }
                if let Some(accelerator) = accelerator
                    && let Some(key) = key_equivalent(accelerator.code)
                {
                    menu_item.setKeyEquivalent(&NSString::from_str(&key));
                    menu_item.setKeyEquivalentModifierMask(modifier_flags(accelerator.modifiers));
                }
                if *item == Some(TrayItem::OpenSettings) {
                    menu_item.setKeyEquivalent(&NSString::from_str(","));
                    menu_item.setKeyEquivalentModifierMask(NSEventModifierFlags::Command);
                }
                if *item == Some(TrayItem::Quit) {
                    // Lowercase: an uppercase equivalent implies Shift, which
                    // rendered this as ⇧⌘Q.
                    menu_item.setKeyEquivalent(&NSString::from_str("q"));
                    menu_item.setKeyEquivalentModifierMask(NSEventModifierFlags::Command);
                }
                if *item == Some(TrayItem::Quit) {
                    menu_item.setKeyEquivalent(&NSString::from_str("q"));
                    menu_item.setKeyEquivalentModifierMask(NSEventModifierFlags::Command);
                }
                // Previous's rows are photo thumbnails; every other iconed row
                // is an SF Symbol, template-tinted by the menu. Windows draws
                // `icon`'s raster instead.
                let photo = matches!(item, Some(TrayItem::PreviousItem(_)));
                let image = if photo {
                    let image = icon
                        .as_deref()
                        .and_then(|bytes| ns_image(bytes, ICON_HEIGHT));
                    if image.is_none() {
                        tracing::warn!(%title, "no thumbnail for a previous row");
                    }
                    image
                } else if let Some(symbol) = item.as_ref().and_then(row_symbol) {
                    let image = symbol_image(symbol);
                    if image.is_none() {
                        tracing::warn!(%title, symbol, "SF Symbol not resolved");
                    }
                    image
                } else {
                    None
                };

                if let Some(image) = image {
                    image.setTemplate(!photo);
                    menu_item.setImage(Some(&image));
                    crate::platform::set_nsmenu_item_prefers_visible_image(&menu_item);
                }
                menu_item
            }
            Entry::SectionHeader { title } => {
                if objc2::available!(macos = 14.0) {
                    NSMenuItem::sectionHeaderWithTitle(&NSString::from_str(title), mtm)
                } else {
                    let menu_item = NSMenuItem::new(mtm);
                    menu_item.setTitle(&NSString::from_str(title));
                    menu_item.setEnabled(false);
                    menu_item
                }
            }
            Entry::Submenu {
                title,
                enabled,
                items,
                icon,
            } => {
                let menu_item = new_menu_item(title, Some(sel!(capTrayItem:)), mtm);
                unsafe { menu_item.setTarget(Some(target)) };
                let submenu = NSMenu::new(mtm);
                submenu.setAutoenablesItems(false);
                for item in items {
                    submenu.addItem(&build_ns_item(item, target, actions, mtm));
                }
                menu_item.setSubmenu(Some(&submenu));
                // Only Previous carries a header glyph; its own rows keep
                // their photos, its header gets the symbol Windows draws the
                // raster for.
                if icon.is_some()
                    && let Some(image) = symbol_image(PREVIOUS_SYMBOL)
                {
                    image.setTemplate(true);
                    menu_item.setImage(Some(&image));
                }
                menu_item.setEnabled(*enabled);
                menu_item
            }
        }
    }

    pub(super) fn modifier_flags(modifiers: super::Modifiers) -> NSEventModifierFlags {
        let mut flags = NSEventModifierFlags::empty();
        if modifiers.contains(super::Modifiers::SUPER) {
            flags |= NSEventModifierFlags::Command;
        }
        if modifiers.contains(super::Modifiers::CONTROL) {
            flags |= NSEventModifierFlags::Control;
        }
        if modifiers.contains(super::Modifiers::ALT) {
            flags |= NSEventModifierFlags::Option;
        }
        if modifiers.contains(super::Modifiers::SHIFT) {
            flags |= NSEventModifierFlags::Shift;
        }
        flags
    }

    /// The character AppKit wants for a menu key equivalent. Function keys use
    /// the `NSF1FunctionKey`..`NSF35FunctionKey` private-use range.
    pub(super) fn key_equivalent(code: super::Code) -> Option<String> {
        use super::Code;

        let character = match code {
            Code::KeyA => "a",
            Code::KeyB => "b",
            Code::KeyC => "c",
            Code::KeyD => "d",
            Code::KeyE => "e",
            Code::KeyF => "f",
            Code::KeyG => "g",
            Code::KeyH => "h",
            Code::KeyI => "i",
            Code::KeyJ => "j",
            Code::KeyK => "k",
            Code::KeyL => "l",
            Code::KeyM => "m",
            Code::KeyN => "n",
            Code::KeyO => "o",
            Code::KeyP => "p",
            Code::KeyQ => "q",
            Code::KeyR => "r",
            Code::KeyS => "s",
            Code::KeyT => "t",
            Code::KeyU => "u",
            Code::KeyV => "v",
            Code::KeyW => "w",
            Code::KeyX => "x",
            Code::KeyY => "y",
            Code::KeyZ => "z",
            Code::Digit0 => "0",
            Code::Digit1 => "1",
            Code::Digit2 => "2",
            Code::Digit3 => "3",
            Code::Digit4 => "4",
            Code::Digit5 => "5",
            Code::Digit6 => "6",
            Code::Digit7 => "7",
            Code::Digit8 => "8",
            Code::Digit9 => "9",
            Code::Backquote => "`",
            Code::Backslash => "\\",
            Code::BracketLeft => "[",
            Code::BracketRight => "]",
            Code::Comma => ",",
            Code::Equal => "=",
            Code::Minus => "-",
            Code::Period => ".",
            Code::Quote => "'",
            Code::Semicolon => ";",
            Code::Slash => "/",
            Code::Space => " ",
            Code::Enter => "\r",
            Code::Tab => "\t",
            Code::Escape => "\u{1b}",
            Code::Backspace => "\u{8}",
            Code::Delete => "\u{7f}",
            Code::ArrowUp => "\u{f700}",
            Code::ArrowDown => "\u{f701}",
            Code::ArrowLeft => "\u{f702}",
            Code::ArrowRight => "\u{f703}",
            Code::Home => "\u{f729}",
            Code::End => "\u{f72b}",
            Code::PageUp => "\u{f72c}",
            Code::PageDown => "\u{f72d}",
            Code::F1 => "\u{f704}",
            Code::F2 => "\u{f705}",
            Code::F3 => "\u{f706}",
            Code::F4 => "\u{f707}",
            Code::F5 => "\u{f708}",
            Code::F6 => "\u{f709}",
            Code::F7 => "\u{f70a}",
            Code::F8 => "\u{f70b}",
            Code::F9 => "\u{f70c}",
            Code::F10 => "\u{f70d}",
            Code::F11 => "\u{f70e}",
            Code::F12 => "\u{f70f}",
            Code::F13 => "\u{f710}",
            Code::F14 => "\u{f711}",
            Code::F15 => "\u{f712}",
            Code::F16 => "\u{f713}",
            Code::F17 => "\u{f714}",
            Code::F18 => "\u{f715}",
            Code::F19 => "\u{f716}",
            Code::F20 => "\u{f717}",
            _ => return None,
        };
        Some(character.to_string())
    }

    fn new_menu_item(
        title: &str,
        action: Option<Sel>,
        mtm: MainThreadMarker,
    ) -> Retained<NSMenuItem> {
        let item = NSMenuItem::new(mtm);
        item.setTitle(&NSString::from_str(title));
        unsafe { item.setAction(action) };
        item.setKeyEquivalent(&NSString::from_str(""));
        item
    }

    /// `RecordingStarted` / `RecordingStopped`.
    ///
    /// The icon swap is the visible half; the mechanism is the other one. A
    /// status item with a menu attached never delivers its button's action --
    /// AppKit opens the menu instead -- so stopping a recording by clicking the
    /// status item means *detaching* the menu and giving the button a
    /// target/action, then putting the menu back when the recording ends.
    pub fn set_recording(recording: bool, cx: &mut App) {
        if !cx.has_global::<Tray>() {
            return;
        }
        cx.global_mut::<Tray>().recording = recording;
        let tray = cx.global::<Tray>();
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let button = tray.status_item.button(mtm);
        if recording {
            tray.status_item.setMenu(None);
            if let Some(button) = button {
                unsafe { button.setTarget(Some(&*tray.target)) };
                unsafe { button.setAction(Some(sel!(capTrayStop:))) };
            }
            set_button_image(tray, STOP_ICON);
        } else {
            if let Some(button) = button {
                unsafe { button.setAction(None) };
                unsafe { button.setTarget(None) };
            }
            tray.status_item.setMenu(tray.menu.as_deref());
            set_button_image(tray, mode_icon(tray.mode));
        }
        tracing::info!(recording, "tray recording state");
    }

    /// `update_tray_icon_for_mode` + `refresh_tray_menu`: the icon follows the
    /// mode and the ✓ moves.
    ///
    /// Takes the mode rather than re-reading the store, because the caller has
    /// only just written it and a re-read is a race the tray loses (the ✓ stays
    /// on the old mode and the icon never swaps).
    pub fn mode_changed(mode: Mode, cx: &mut App) {
        if !cx.has_global::<Tray>() {
            return;
        }
        if cx.global::<Tray>().mode == mode {
            return;
        }
        cx.global_mut::<Tray>().mode = mode;
        if !cx.global::<Tray>().recording {
            let tray = cx.global::<Tray>();
            set_button_image(tray, mode_icon(mode));
        }
        rebuild(cx);
    }

    /// `NewStudioRecordingAdded` -> `add_new_item_to_cache` + `refresh_tray_menu`.
    pub fn refresh_previous(cx: &mut App) {
        if !cx.has_global::<Tray>() {
            return;
        }
        let tray = cx.global_mut::<Tray>();
        tray.previous_generation = tray.previous_generation.wrapping_add(1);
        let generation = tray.previous_generation;
        cx.spawn(async move |cx| {
            let previous = cx
                .background_executor()
                .spawn(async { scan_previous(true) })
                .await;
            cx.update(|cx| {
                if !cx.has_global::<Tray>() || cx.global::<Tray>().previous_generation != generation
                {
                    return;
                }
                cx.global_mut::<Tray>().previous = previous;
                rebuild(cx);
            });
        })
        .detach();
    }

    /// The Previous items currently in the menu -- the harness reads this to
    /// pick one to activate, and the recording-lifecycle check asserts the new
    /// recording landed in it.
    pub fn previous_items(cx: &App) -> Vec<PreviousItem> {
        if !cx.has_global::<Tray>() {
            return Vec::new();
        }
        cx.global::<Tray>().previous.clone()
    }

    /// The menu as it currently stands, for the harness dump.
    pub fn menu_snapshot(cx: &App) -> Vec<Entry> {
        if !cx.has_global::<Tray>() {
            return Vec::new();
        }
        let tray = cx.global::<Tray>();
        current_menu_entries(cx, tray.mode, &tray.previous)
    }

    pub fn refresh_menu(cx: &mut App) {
        rebuild(cx);
    }
}

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
pub use windows::*;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod stub {
    use gpui::App;

    use super::{Entry, PreviousItem, current_menu_entries, scan_previous};

    pub fn init(_cx: &mut App) {}
    pub fn set_recording(_recording: bool, _cx: &mut App) {}
    pub fn mode_changed(_mode: crate::main_window::Mode, _cx: &mut App) {}
    pub fn refresh_previous(_cx: &mut App) {}
    pub fn refresh_menu(_cx: &mut App) {}
    pub fn previous_items(_cx: &App) -> Vec<PreviousItem> {
        scan_previous(false)
    }
    pub fn menu_snapshot(cx: &App) -> Vec<Entry> {
        current_menu_entries(
            cx,
            crate::main_window::Mode::from_store(),
            &scan_previous(false),
        )
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use stub::*;

/// Keeps the `Global` import honest on non-mac builds.
#[allow(dead_code)]
fn _global_bound<T: Global>() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_truncate_at_thirty_characters() {
        assert_eq!(truncate_title("short"), "short");
        let exactly_thirty = "a".repeat(30);
        assert_eq!(truncate_title(&exactly_thirty), exactly_thirty);

        let thirty_one = "a".repeat(31);
        let truncated = truncate_title(&thirty_one);
        assert_eq!(truncated.chars().count(), 30);
        assert!(truncated.ends_with('\u{2026}'));
        assert_eq!(truncated, format!("{}\u{2026}", "a".repeat(29)));
    }

    /// The byte-index dance in `truncate_title` exists for exactly this: a
    /// title of multi-byte characters must not be sliced mid-character.
    #[test]
    fn titles_truncate_on_character_boundaries() {
        let japanese = "画面収録".repeat(10); // 40 characters, 120 bytes
        let truncated = truncate_title(&japanese);
        assert_eq!(truncated.chars().count(), 30);
        assert!(truncated.ends_with('\u{2026}'));
        assert!(truncated.starts_with("画面収録"));

        // A grapheme built from a base plus a combining mark still counts as
        // two `char`s, which is what the Tauri version counts too.
        let combining = "e\u{0301}".repeat(20);
        assert_eq!(truncate_title(&combining).chars().count(), 30);
    }

    /// `load_thumbnail_data`'s cover-crop: the scale is the *max* of the two
    /// ratios, so the short side reaches 32 and the long side overhangs, and
    /// the overhang is split evenly.
    #[test]
    fn thumbnails_cover_crop_from_the_centre() {
        // Wide: 1920x1080 -> scale 32/1080, so 57x32 with 12px cropped each side.
        assert_eq!(cover_crop_geometry(1920, 1080, 32), (57, 32, 12, 0));
        // Tall: 1080x1920 -> the transpose.
        assert_eq!(cover_crop_geometry(1080, 1920, 32), (32, 57, 0, 12));
        // Square: no crop at all.
        assert_eq!(cover_crop_geometry(424, 424, 32), (32, 32, 0, 0));
        // Smaller than the target still upscales to cover.
        assert_eq!(cover_crop_geometry(16, 8, 32), (64, 32, 16, 0));
    }

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("cap-tray-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        root
    }

    fn bundle_display_jpg(bundle: &Path, width: u32, height: u32) -> PathBuf {
        let screenshots = bundle.join("screenshots");
        std::fs::create_dir_all(&screenshots).unwrap();
        let display = screenshots.join("display.jpg");
        image::RgbImage::from_fn(width, height, |x, y| {
            let noise = (x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663)) % 48;
            image::Rgb([
                (x * 255 / width) as u8 ^ noise as u8,
                (y * 255 / height) as u8,
                ((x + y) % 256) as u8,
            ])
        })
        .save_with_format(&display, image::ImageFormat::Jpeg)
        .unwrap();
        display
    }

    fn cached_thumbnails(display: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(display.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("thumbnail-"))
            })
            .collect()
    }

    #[test]
    fn previous_thumbnails_reuse_the_recents_cache() {
        let root = temp_root("cache");
        let display = bundle_display_jpg(&root.join("bundle.cap"), 1512, 982);

        let cold = load_thumbnail_png(&display).expect("a thumbnail from the original");
        let cold = image::load_from_memory(&cold).unwrap();
        assert_eq!(
            (cold.width(), cold.height()),
            (THUMBNAIL_SIZE, THUMBNAIL_SIZE)
        );
        let cached = cached_thumbnails(&display);
        assert_eq!(cached.len(), 1, "the first scan fills the Recents cache");
        assert_eq!(image::image_dimensions(&cached[0]).unwrap(), (392, 255));

        let marker = image::Rgb([200, 30, 90]);
        image::RgbImage::from_pixel(392, 255, marker)
            .save_with_format(&cached[0], image::ImageFormat::Jpeg)
            .unwrap();
        let marker_bytes = std::fs::read(&cached[0]).unwrap();

        let warm = load_thumbnail_png(&display).expect("a thumbnail from the cache");
        assert_eq!(cached_thumbnails(&display), cached);
        assert_eq!(
            std::fs::read(&cached[0]).unwrap(),
            marker_bytes,
            "a hit rewrites nothing"
        );
        let warm = image::load_from_memory(&warm).unwrap().into_rgb8();
        assert!(
            warm.pixels().all(|pixel| pixel
                .0
                .iter()
                .zip(marker.0)
                .all(|(a, b)| a.abs_diff(b) <= 3)),
            "the warm icon is built from the cached thumbnail, not the original"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn previous_thumbnails_keep_png_transparency_cold_and_warm() {
        let root = temp_root("alpha");
        std::fs::create_dir_all(&root).unwrap();
        let png = root.join("screenshot.png");
        image::RgbaImage::from_fn(800, 600, |x, _| {
            if x < 400 {
                image::Rgba([0, 0, 0, 0])
            } else {
                image::Rgba([220, 40, 40, 255])
            }
        })
        .save_with_format(&png, image::ImageFormat::Png)
        .unwrap();

        for scan in ["cold", "warm"] {
            let icon = image::load_from_memory(&load_thumbnail_png(&png).unwrap())
                .unwrap()
                .into_rgba8();
            assert_eq!(icon.dimensions(), (THUMBNAIL_SIZE, THUMBNAIL_SIZE));
            assert!(icon.get_pixel(0, 0)[3] < 8, "{scan} scan lost the corner");
            assert!(
                icon.get_pixel(2, 16)[3] < 8,
                "{scan} scan lost the transparent half"
            );
            assert!(
                icon.get_pixel(29, 16)[3] > 247,
                "{scan} scan lost the opaque half"
            );
        }
        let cache = library::thumbnail_cache_file(&png).unwrap();
        assert!(
            !cache.exists(),
            "a transparent PNG never goes through the alpha-dropping cache"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn previous_thumbnails_reuse_the_cache_for_an_opaque_png() {
        let root = temp_root("opaque-png");
        std::fs::create_dir_all(&root).unwrap();
        let png = root.join("screenshot.png");
        image::RgbImage::from_pixel(1280, 720, image::Rgb([20, 120, 220]))
            .save_with_format(&png, image::ImageFormat::Png)
            .unwrap();
        let cache = library::thumbnail_cache_file(&png).unwrap();
        std::fs::remove_file(&cache).ok();

        let cold = image::load_from_memory(&load_thumbnail_png(&png).unwrap())
            .unwrap()
            .into_rgba8();
        assert_eq!(cold.dimensions(), (THUMBNAIL_SIZE, THUMBNAIL_SIZE));
        assert_eq!(cold.get_pixel(0, 0)[3], 255);
        assert!(cache.exists(), "the first scan fills the shared cache");

        let marker = image::Rgb([200, 30, 90]);
        image::RgbImage::from_pixel(398, 224, marker)
            .save_with_format(&cache, image::ImageFormat::Jpeg)
            .unwrap();
        let warm = image::load_from_memory(&load_thumbnail_png(&png).unwrap())
            .unwrap()
            .into_rgba8();
        assert_eq!(warm.dimensions(), (THUMBNAIL_SIZE, THUMBNAIL_SIZE));
        assert!(
            warm.pixels().all(|pixel| pixel.0[..3]
                .iter()
                .zip(marker.0)
                .all(|(a, b)| a.abs_diff(b) <= 3)
                && pixel.0[3] == 255),
            "the warm icon is built from the cached thumbnail, not the original"
        );

        std::fs::remove_file(&cache).ok();
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    #[ignore]
    fn benchmark_previous_thumbnails() {
        use std::time::Instant;

        let root = temp_root("bench");
        let displays: Vec<_> = (0..MAX_PREVIOUS_ITEMS)
            .map(|index| bundle_display_jpg(&root.join(format!("{index}.cap")), 3024, 1964))
            .collect();
        let scan = || {
            let start = Instant::now();
            for display in &displays {
                let png = load_thumbnail_png(display).unwrap();
                assert_eq!(
                    image::load_from_memory(&png).unwrap().width(),
                    THUMBNAIL_SIZE
                );
            }
            start.elapsed().as_secs_f64() * 1000.0
        };
        let mut cold = Vec::new();
        let mut warm = Vec::new();
        for _ in 0..5 {
            for display in &displays {
                for path in cached_thumbnails(display) {
                    std::fs::remove_file(path).unwrap();
                }
            }
            cold.push(scan());
            warm.push(scan());
        }
        cold.sort_by(f64::total_cmp);
        warm.sort_by(f64::total_cmp);
        println!(
            "{{\"items\":{MAX_PREVIOUS_ITEMS},\"source\":\"3024x1964 jpeg\",\"cold_scan_median_ms\":{:.1},\"warm_scan_median_ms\":{:.1}}}",
            cold[2], warm[2]
        );
        std::fs::remove_dir_all(&root).ok();
    }

    fn titles(entries: &[Entry]) -> Vec<String> {
        entries
            .iter()
            .map(|entry| match entry {
                Entry::Separator => "-".to_string(),
                Entry::ModePicker { mode } => mode_name(*mode).to_string(),
                Entry::SectionHeader { title } => title.clone(),
                Entry::Item { title, .. } => title.clone(),
                Entry::Submenu { title, .. } => title.clone(),
            })
            .collect()
    }

    #[test]
    fn onboarding_menu_is_permissions_only() {
        let menu = build_onboarding_menu("0.1.0");
        assert_eq!(
            titles(&menu),
            vec!["Request Permissions", "-", "Cap v0.1.0", "Quit Cap",]
        );
    }

    #[test]
    fn menu_matches_build_tray_menu() {
        let menu = build_menu(Mode::Studio, &[], "0.1.0");
        // macOS renders the group as a section header naming the current
        // mode; the `mode_submenu` other platforms get keeps its group label.
        let mode_label = if cfg!(target_os = "macos") {
            "Studio"
        } else {
            "Select Mode"
        };
        let mut expected = vec!["Open Main Window", "-", mode_label, "-"];
        expected.extend([
            "Record Display",
            "Record Window",
            "Record Area",
            "Take a Screenshot",
            "-",
            "Previous",
            "View all recordings",
            "View all screenshots",
            "-",
            "Import Media...",
            "Settings",
            "Upload Logs",
            "-",
        ]);
        // The version row is a section header below Quit on macOS and a
        // disabled row above it everywhere else.
        if cfg!(target_os = "macos") {
            expected.extend(["Quit Cap", "Cap v0.1.0"]);
        } else {
            expected.extend(["Cap v0.1.0", "Quit Cap"]);
        }
        assert_eq!(titles(&menu), expected);
    }

    /// Screenshot mode relabels the three target rows and drops "Take a
    /// Screenshot" entirely.
    #[test]
    fn screenshot_mode_relabels_the_capture_rows() {
        let menu = build_menu(Mode::Screenshot, &[], "0.1.0");
        let titles = titles(&menu);
        let mode_label = if cfg!(target_os = "macos") {
            "Screenshot"
        } else {
            "Select Mode"
        };
        assert_eq!(
            &titles[..6],
            &[
                "Open Main Window",
                "-",
                mode_label,
                "-",
                "Screenshot Display",
                "Screenshot Window",
            ]
        );
        assert!(!titles.iter().any(|title| title == "Take a Screenshot"));
    }

    #[test]
    fn the_current_mode_is_ticked() {
        for (mode, expected) in [
            (
                Mode::Studio,
                ["\u{2713} Studio", "   Instant", "   Screenshot"],
            ),
            (
                Mode::Instant,
                ["   Studio", "\u{2713} Instant", "   Screenshot"],
            ),
            (
                Mode::Screenshot,
                ["   Studio", "   Instant", "\u{2713} Screenshot"],
            ),
        ] {
            let Entry::Submenu { items, .. } = mode_submenu(mode) else {
                panic!("the mode picker is a submenu");
            };
            assert_eq!(titles(&items), expected.to_vec());
        }
    }

    #[test]
    fn previous_is_disabled_and_says_so_when_empty() {
        let Entry::Submenu {
            title,
            enabled,
            items,
            ..
        } = previous_submenu(&[])
        else {
            panic!("Previous is a submenu");
        };
        assert_eq!(title, "Previous");
        assert!(!enabled);
        assert_eq!(titles(&items), vec!["No recent items"]);
        assert!(matches!(items[0], Entry::Item { enabled: false, .. }));
    }

    #[test]
    fn previous_items_carry_their_type_prefix() {
        let items = [
            (
                MediaKind::Studio,
                "Screen Recording",
                "\u{1f3ac} Screen Recording",
            ),
            (MediaKind::Instant, "Quick Take", "\u{26a1} Quick Take"),
            (MediaKind::Screenshot, "Shot", "\u{1f4f7} Shot"),
        ]
        .map(|(kind, name, _)| PreviousItem {
            path: PathBuf::from(format!("/tmp/{name}.cap")),
            kind,
            pretty_name: name.to_string(),
            thumbnail: None,
        });
        let Entry::Submenu { items, enabled, .. } = previous_submenu(&items) else {
            panic!("Previous is a submenu");
        };
        assert!(enabled);
        assert_eq!(
            titles(&items),
            vec![
                "\u{1f3ac} Screen Recording",
                "\u{26a1} Quick Take",
                "\u{1f4f7} Shot",
            ]
        );
    }

    /// Only the rows with a real handler are enabled; the deviations are
    /// present and greyed, in place, so the menu keeps its shape.
    #[test]
    fn unimplemented_rows_are_present_but_disabled() {
        let menu = build_menu(Mode::Instant, &[], "0.1.0");
        let disabled: Vec<_> = menu
            .iter()
            .filter_map(|entry| match entry {
                Entry::Item {
                    title,
                    enabled: false,
                    ..
                } => Some(title.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            disabled,
            if cfg!(target_os = "macos") {
                vec!["Upload Logs"]
            } else {
                vec!["Upload Logs", "Cap v0.1.0"]
            }
        );
    }
    #[test]
    fn capture_rows_have_one_entry_per_action() {
        let rows: Vec<_> = build_menu(Mode::Studio, &[], "0.1.0")
            .into_iter()
            .filter_map(|entry| match entry {
                Entry::Item {
                    title,
                    item: Some(item),
                    ..
                } if matches!(
                    item,
                    TrayItem::RecordDisplay
                        | TrayItem::RecordWindow
                        | TrayItem::RecordArea
                        | TrayItem::ScreenshotDisplay
                        | TrayItem::ScreenshotWindow
                        | TrayItem::ScreenshotArea
                ) =>
                {
                    Some((title, item))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            rows,
            vec![
                ("Record Display".to_string(), TrayItem::RecordDisplay),
                ("Record Window".to_string(), TrayItem::RecordWindow),
                ("Record Area".to_string(), TrayItem::RecordArea),
            ]
        );

        let rows: Vec<_> = build_menu(Mode::Screenshot, &[], "0.1.0")
            .into_iter()
            .filter_map(|entry| match entry {
                Entry::Item {
                    title,
                    item: Some(item),
                    ..
                } if matches!(
                    item,
                    TrayItem::RecordDisplay
                        | TrayItem::RecordWindow
                        | TrayItem::RecordArea
                        | TrayItem::ScreenshotDisplay
                        | TrayItem::ScreenshotWindow
                        | TrayItem::ScreenshotArea
                ) =>
                {
                    Some((title, item))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            rows,
            vec![
                (
                    "Screenshot Display".to_string(),
                    TrayItem::ScreenshotDisplay
                ),
                ("Screenshot Window".to_string(), TrayItem::ScreenshotWindow),
                ("Screenshot Area".to_string(), TrayItem::ScreenshotArea),
            ]
        );
    }

    #[test]
    fn screenshot_mode_drops_take_a_screenshot_and_recording_mode_keeps_it() {
        let has = |mode| {
            build_menu(mode, &[], "0.1.0").iter().any(|entry| {
                matches!(
                    entry,
                    Entry::Item {
                        item: Some(TrayItem::TakeScreenshot),
                        ..
                    }
                )
            })
        };
        assert!(has(Mode::Studio));
        assert!(has(Mode::Instant));
        assert!(!has(Mode::Screenshot));
    }

    #[test]
    fn capture_rows_look_up_their_own_hotkey() {
        assert_eq!(
            hotkey_action(&TrayItem::RecordDisplay),
            Some(HotkeyAction::OpenRecordingPickerDisplay)
        );
        assert_eq!(
            hotkey_action(&TrayItem::ScreenshotDisplay),
            Some(HotkeyAction::ScreenshotDisplay)
        );
        assert_eq!(
            hotkey_action(&TrayItem::TakeScreenshot),
            Some(HotkeyAction::ScreenshotDisplay)
        );
        assert_eq!(
            hotkey_action(&TrayItem::ScreenshotWindow),
            Some(HotkeyAction::ScreenshotWindow)
        );
        assert_eq!(
            hotkey_action(&TrayItem::RecordWindow),
            Some(HotkeyAction::OpenRecordingPickerWindow)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn accelerators_render_as_appkit_key_equivalents() {
        let flags = mac::modifier_flags(Modifiers::SUPER | Modifiers::SHIFT);
        assert!(flags.contains(objc2_app_kit::NSEventModifierFlags::Command));
        assert!(flags.contains(objc2_app_kit::NSEventModifierFlags::Shift));
        assert_eq!(mac::key_equivalent(Code::Digit4).as_deref(), Some("4"));
        assert_eq!(mac::key_equivalent(Code::KeyS).as_deref(), Some("s"));
        assert_eq!(mac::key_equivalent(Code::F1).as_deref(), Some("\u{f704}"));
        assert_eq!(mac::key_equivalent(Code::MetaLeft), None);
    }
}
