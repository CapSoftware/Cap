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
//! Same seam `platform::open_color_panel` uses for `changeColor:`.
//!
//! Menu strings, order and separators are byte-identical to `build_tray_menu`.
//! Deviations, all deliberate and all noted in the module below: the
//! onboarding-minimal variant is not reproduced (this app has no onboarding
//! window), and "Take a Screenshot", "Import Media..." and "Upload Logs" render
//! disabled because the capture, import and log-upload paths do not exist here.

use std::path::{Path, PathBuf};

use gpui::{App, Global};

use crate::{
    app_windows,
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
fn mode_icon(mode: Mode) -> &'static [u8] {
    match mode {
        Mode::Studio => include_bytes!("../assets/tray/tray-default-icon-studio.png"),
        Mode::Instant => include_bytes!("../assets/tray/tray-default-icon-instant.png"),
        Mode::Screenshot => include_bytes!("../assets/tray/tray-default-icon-screenshot.png"),
    }
}

/// `set_tray_stop_icon`.
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
    ViewAllRecordings,
    ViewAllScreenshots,
    OpenSettings,
    Quit,
    PreviousItem(PathBuf),
    ModeStudio,
    ModeInstant,
    ModeScreenshot,
}

/// One row of the menu.
#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    Separator,
    Item {
        title: String,
        item: Option<TrayItem>,
        enabled: bool,
        /// A 32x32 PNG, already cover-cropped. `IconMenuItem`'s image.
        icon: Option<Vec<u8>>,
    },
    Submenu {
        title: String,
        enabled: bool,
        items: Vec<Entry>,
    },
}

impl Entry {
    fn item(title: impl Into<String>, item: TrayItem) -> Self {
        Self::Item {
            title: title.into(),
            item: Some(item),
            enabled: true,
            icon: None,
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
/// same conversion one step earlier.
fn load_thumbnail_png(path: &Path) -> Option<Vec<u8>> {
    use image::{GenericImageView, ImageEncoder, RgbaImage, imageops::FilterType};

    let bytes = std::fs::read(path).ok()?;
    let img = image::load_from_memory(&bytes).ok()?;
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
            title: "Previous".into(),
            enabled: false,
            items: vec![Entry::disabled("No recent items")],
        };
    }
    Entry::Submenu {
        title: "Previous".into(),
        enabled: true,
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
            })
            .collect(),
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
        title: "Select Mode".into(),
        enabled: true,
        items: vec![
            label(Mode::Studio, "Studio"),
            label(Mode::Instant, "Instant"),
            label(Mode::Screenshot, "Screenshot"),
        ],
    }
}

/// `build_tray_menu`, minus the onboarding-minimal branch.
pub fn build_menu(mode: Mode, previous: &[PreviousItem], version: &str) -> Vec<Entry> {
    let mut entries = vec![Entry::item("Open Main Window", TrayItem::OpenCap)];

    if mode == Mode::Screenshot {
        entries.push(Entry::item("Screenshot Display", TrayItem::RecordDisplay));
        entries.push(Entry::item("Screenshot Window", TrayItem::RecordWindow));
        entries.push(Entry::item("Screenshot Area", TrayItem::RecordArea));
    } else {
        entries.push(Entry::item("Record Display", TrayItem::RecordDisplay));
        entries.push(Entry::item("Record Window", TrayItem::RecordWindow));
        entries.push(Entry::item("Record Area", TrayItem::RecordArea));
        // `recording::take_screenshot` has no gpui counterpart yet, so the row
        // is present and greyed rather than silently missing.
        entries.push(Entry::disabled("Take a Screenshot"));
    }

    // `crate::import::start_video_import` / `start_image_import`: no import
    // infrastructure here either.
    entries.push(Entry::disabled("Import Media..."));

    entries.push(Entry::Separator);
    entries.push(mode_submenu(mode));
    entries.push(previous_submenu(previous));
    entries.push(Entry::Separator);

    entries.push(Entry::item("View all recordings", TrayItem::ViewAllRecordings));
    entries.push(Entry::item(
        "View all screenshots",
        TrayItem::ViewAllScreenshots,
    ));
    entries.push(Entry::item("Settings", TrayItem::OpenSettings));

    entries.push(Entry::Separator);
    // `logging::upload_log_file` needs the auth token and the HTTP client,
    // neither of which this app has.
    entries.push(Entry::disabled("Upload Logs"));
    entries.push(Entry::disabled(format!("Cap v{version}")));
    entries.push(Entry::item("Quit Cap", TrayItem::Quit));

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
        TrayItem::RecordDisplay => app_windows::arm_target_mode(TargetType::Display, cx),
        TrayItem::RecordWindow => app_windows::arm_target_mode(TargetType::Window, cx),
        TrayItem::RecordArea => app_windows::arm_target_mode(TargetType::Area, cx),
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
        TrayItem::Quit => menus::quit(cx),
        TrayItem::PreviousItem(path) => open_previous_item(path, cx),
        TrayItem::ModeStudio => set_mode(Mode::Studio, cx),
        TrayItem::ModeInstant => set_mode(Mode::Instant, cx),
        TrayItem::ModeScreenshot => set_mode(Mode::Screenshot, cx),
    }
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
fn open_previous_item(path: PathBuf, cx: &mut App) {
    use cap_project::{RecordingMeta, RecordingMetaInner};

    let screenshots_dir = library::screenshots_dir();
    let is_screenshot = path.extension().and_then(|ext| ext.to_str()) == Some("cap")
        && path.parent().map(|parent| parent == screenshots_dir).unwrap_or(false);

    if is_screenshot {
        // `ShowCapWindow::ScreenshotEditor` has no gpui counterpart yet
        // (deviation): the bundle is revealed in Finder instead, which is what
        // a Recents screenshot card does in this app.
        library::open_recording_folder(&path, library::RecordingMode::Studio);
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
                open_with_finder(&sharing.link);
            } else {
                let mp4 = path.join("content/output.mp4");
                if mp4.exists() {
                    open_with_finder(&mp4.to_string_lossy());
                }
            }
        }
    }
}

/// `tauri_plugin_opener`'s `open_url` / `open_path`, which on macOS are both
/// `open <thing>` -- the same spawn `library::open_recording_folder` uses.
fn open_with_finder(target: &str) {
    #[cfg(target_os = "macos")]
    if let Err(error) = std::process::Command::new("open").arg(target).spawn() {
        tracing::warn!(target, "opening from the tray failed: {error}");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = target;
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
/// row is suffixed with ` [disabled]`; a row with a thumbnail with ` [icon]`.
pub fn describe_menu(entries: &[Entry]) -> String {
    fn walk(entries: &[Entry], depth: usize, out: &mut String) {
        for entry in entries {
            let pad = "  ".repeat(depth);
            match entry {
                Entry::Separator => out.push_str(&format!("{pad}---\n")),
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
                } => {
                    out.push_str(&format!(
                        "{pad}{title}{}\n",
                        if *enabled { "" } else { " [disabled]" }
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
    let spec = std::env::var("CAP_GPUI_AUTO_TRAY").ok().filter(|s| !s.is_empty());
    let dump = std::env::var("CAP_GPUI_TRAY_DUMP").ok().filter(|s| !s.is_empty());
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
mod mac {
    use std::cell::RefCell;

    use gpui::{App, Global};
    use objc2::rc::Id;
    use objc2::runtime::{AnyObject, Sel};
    use objc2::{ClassType, DeclaredClass, class, msg_send, msg_send_id, sel};
    use objc2_foundation::NSString;

    use super::{
        Entry, PreviousItem, STOP_ICON, TrayItem, build_menu, handle_item, mode_icon,
        scan_previous, stop_recording,
    };
    use crate::{main_window::Mode, menus};

    /// `NSVariableStatusItemLength`.
    const NS_VARIABLE_STATUS_ITEM_LENGTH: f64 = -1.0;
    /// The point height tray-icon and muda both scale a status-item image and a
    /// menu-item icon to.
    const ICON_HEIGHT: f64 = 18.0;
    /// Not a menu item: the status button itself, clicked mid-recording.
    const STOP_TAG: isize = -1;

    thread_local! {
        /// The live sender, read by the ObjC action. `thread_local` for the
        /// reason `COLOR_PANEL_TX` is: AppKit only calls the action on the main
        /// thread, so it needs no lock.
        static TRAY_TX: RefCell<Option<flume::Sender<isize>>> = const { RefCell::new(None) };
    }

    objc2::declare_class!(
        /// The receiver for every tray action. No ivars: the tag identifies the
        /// item and the sender lives in the thread-local above.
        struct TrayTarget;

        unsafe impl ClassType for TrayTarget {
            type Super = objc2::runtime::NSObject;
            type Mutability = objc2::mutability::InteriorMutable;
            const NAME: &'static str = "CapGpuiTrayTarget";
        }

        impl DeclaredClass for TrayTarget {}

        unsafe impl TrayTarget {
            /// Fires inside AppKit's menu-tracking run loop. Touching gpui here
            /// is what "RefCell already borrowed" looks like, so it only posts
            /// the tag.
            #[method(capTrayItem:)]
            fn tray_item(&self, sender: *mut AnyObject) {
                if sender.is_null() {
                    return;
                }
                let tag: isize = unsafe { msg_send![sender, tag] };
                post(tag);
            }

            /// The status button's action while a recording is running.
            #[method(capTrayStop:)]
            fn tray_stop(&self, _sender: *mut AnyObject) {
                post(STOP_TAG);
            }
        }
    );

    fn post(tag: isize) {
        TRAY_TX.with(|tx| {
            if let Some(sender) = tx.borrow().as_ref() {
                let _ = sender.send(tag);
            }
        });
    }

    struct Tray {
        status_item: Id<AnyObject>,
        target: Id<TrayTarget>,
        /// Retained so the menu can be detached (recording) and reattached
        /// (stopped) without rebuilding it.
        menu: Option<Id<AnyObject>>,
        /// Tag -> item, rebuilt with the menu. The index *is* the tag.
        actions: Vec<TrayItem>,
        mode: Mode,
        previous: Vec<PreviousItem>,
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

        let (tx, rx) = flume::unbounded::<isize>();
        TRAY_TX.with(|slot| *slot.borrow_mut() = Some(tx));

        // The drain. One task for the life of the process: every tray click
        // arrives here, on the foreground executor, with nothing borrowed.
        cx.spawn(async move |cx| {
            while let Ok(tag) = rx.recv_async().await {
                let _ = cx.update(|cx| {
                    if tag == STOP_TAG {
                        stop_recording(cx);
                        return;
                    }
                    let item = cx
                        .global::<Tray>()
                        .actions
                        .get(tag as usize)
                        .cloned();
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
        unsafe {
            let status_bar: *mut AnyObject = msg_send![class!(NSStatusBar), systemStatusBar];
            if status_bar.is_null() {
                return None;
            }
            let raw: *mut AnyObject =
                msg_send![status_bar, statusItemWithLength: NS_VARIABLE_STATUS_ITEM_LENGTH];
            // `statusItemWithLength:` hands back an autoreleased object owned
            // by the status bar; retain it for as long as we hold it, and never
            // release it -- removing a status item is what makes it disappear
            // from the menu bar, and this one lives for the process.
            let status_item = Id::retain(raw)?;
            let target: Id<TrayTarget> = msg_send_id![TrayTarget::alloc(), init];

            let mode = Mode::from_store();
            let tray = Tray {
                status_item,
                target,
                menu: None,
                actions: Vec::new(),
                mode,
                previous: Vec::new(),
                recording: false,
            };
            set_button_image(&tray, mode_icon(mode));
            let button: *mut AnyObject = msg_send![&*tray.status_item, button];
            let visible: bool = msg_send![&*tray.status_item, isVisible];
            let frame: objc2_foundation::NSRect = if button.is_null() {
                objc2_foundation::NSRect::new(
                    objc2_foundation::NSPoint::new(0., 0.),
                    objc2_foundation::NSSize::new(0., 0.),
                )
            } else {
                msg_send![button, frame]
            };
            tracing::info!(
                has_button = !button.is_null(),
                visible,
                width = frame.size.width,
                height = frame.size.height,
                ?mode,
                "status item created"
            );
            Some(tray)
        }
    }

    /// `set_icon_for_ns_status_item_button`: an 18pt-tall template image on the
    /// status item's button.
    fn set_button_image(tray: &Tray, png: &[u8]) {
        unsafe {
            let button: *mut AnyObject = msg_send![&*tray.status_item, button];
            if button.is_null() {
                return;
            }
            let Some(image) = ns_image(png, ICON_HEIGHT) else {
                return;
            };
            let _: () = msg_send![button, setImage: &*image];
            // `icon_as_template(cfg!(target_os = "macos"))` in `create_tray`.
            let _: () = msg_send![&*image, setTemplate: true];
            // The verification seam. A machine with a full menu bar parks
            // overflow status items behind the notch, where they cannot be
            // photographed -- so which icon is on the button is logged, keyed
            // by the asset's byte length (each of the four differs).
            tracing::info!(
                icon = icon_name(png),
                bytes = png.len(),
                "status item icon set"
            );
        }
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
    fn ns_image(png: &[u8], height: f64) -> Option<Id<AnyObject>> {
        unsafe {
            let data: *mut AnyObject = msg_send![
                class!(NSData),
                dataWithBytes: png.as_ptr().cast::<std::ffi::c_void>(),
                length: png.len(),
            ];
            if data.is_null() {
                return None;
            }
            let alloc: *mut AnyObject = msg_send![class!(NSImage), alloc];
            let raw: *mut AnyObject = msg_send![alloc, initWithData: data];
            let image = Id::from_raw(raw)?;
            let size: objc2_foundation::NSSize = msg_send![&*image, size];
            if size.height > 0.0 {
                let width = size.width / (size.height / height);
                let _: () = msg_send![
                    &*image,
                    setSize: objc2_foundation::NSSize::new(width, height)
                ];
            }
            Some(image)
        }
    }

    /// Rebuild the menu from the current mode and Previous cache, and attach it
    /// (unless a recording is running, in which case the *button* owns the
    /// click -- see [`set_recording`]).
    pub fn rebuild(cx: &mut App) {
        if !cx.has_global::<Tray>() {
            return;
        }
        let (mode, previous) = {
            let tray = cx.global::<Tray>();
            (tray.mode, tray.previous.clone())
        };
        let entries = build_menu(mode, &previous, menus::app_version());

        let mut actions = Vec::new();
        let menu = {
            let tray = cx.global::<Tray>();
            build_ns_menu(&entries, &tray.target, &mut actions)
        };

        let recording = cx.global::<Tray>().recording;
        unsafe {
            if !recording {
                let tray = cx.global::<Tray>();
                let _: () = msg_send![&*tray.status_item, setMenu: &*menu];
            }
        }

        let tray = cx.global_mut::<Tray>();
        tray.actions = actions;
        tray.menu = Some(menu);
    }

    fn build_ns_menu(
        entries: &[Entry],
        target: &TrayTarget,
        actions: &mut Vec<TrayItem>,
    ) -> Id<AnyObject> {
        unsafe {
            let alloc: *mut AnyObject = msg_send![class!(NSMenu), alloc];
            let raw: *mut AnyObject = msg_send![alloc, init];
            let menu = Id::from_raw(raw).expect("NSMenu init returned nil");
            // Without this AppKit decides an item's enabled state from whether
            // its target responds to the action -- which ours always does, so
            // the four deliberately-disabled rows would come back enabled.
            let _: () = msg_send![&*menu, setAutoenablesItems: false];

            for entry in entries {
                let item = build_ns_item(entry, target, actions);
                let _: () = msg_send![&*menu, addItem: &*item];
            }
            menu
        }
    }

    fn build_ns_item(
        entry: &Entry,
        target: &TrayTarget,
        actions: &mut Vec<TrayItem>,
    ) -> Id<AnyObject> {
        unsafe {
            match entry {
                Entry::Separator => {
                    let raw: *mut AnyObject = msg_send![class!(NSMenuItem), separatorItem];
                    Id::retain(raw).expect("separatorItem returned nil")
                }
                Entry::Item {
                    title,
                    item,
                    enabled,
                    icon,
                } => {
                    let menu_item = new_menu_item(title, sel!(capTrayItem:));
                    let _: () = msg_send![&*menu_item, setTarget: target];
                    let _: () = msg_send![&*menu_item, setEnabled: *enabled && item.is_some()];
                    if let Some(item) = item {
                        let tag = actions.len() as isize;
                        let _: () = msg_send![&*menu_item, setTag: tag];
                        actions.push(item.clone());
                    }
                    if let Some(icon) = icon
                        && let Some(image) = ns_image(icon, ICON_HEIGHT)
                    {
                        let _: () = msg_send![&*menu_item, setImage: &*image];
                    }
                    menu_item
                }
                Entry::Submenu {
                    title,
                    enabled,
                    items,
                } => {
                    let menu_item = new_menu_item(title, sel!(capTrayItem:));
                    let submenu = build_ns_menu(items, target, actions);
                    let _: () = msg_send![&*menu_item, setSubmenu: &*submenu];
                    let _: () = msg_send![&*menu_item, setEnabled: *enabled];
                    menu_item
                }
            }
        }
    }

    fn new_menu_item(title: &str, action: Sel) -> Id<AnyObject> {
        unsafe {
            let alloc: *mut AnyObject = msg_send![class!(NSMenuItem), alloc];
            let raw: *mut AnyObject = msg_send![
                alloc,
                initWithTitle: &*NSString::from_str(title),
                action: action,
                keyEquivalent: &*NSString::from_str(""),
            ];
            Id::from_raw(raw).expect("NSMenuItem init returned nil")
        }
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
        unsafe {
            let button: *mut AnyObject = msg_send![&*tray.status_item, button];
            if recording {
                let _: () = msg_send![&*tray.status_item, setMenu: std::ptr::null_mut::<AnyObject>()];
                if !button.is_null() {
                    let _: () = msg_send![button, setTarget: &*tray.target];
                    let _: () = msg_send![button, setAction: Some(sel!(capTrayStop:))];
                }
                set_button_image(tray, STOP_ICON);
            } else {
                if !button.is_null() {
                    let _: () = msg_send![button, setAction: None::<Sel>];
                    let _: () = msg_send![button, setTarget: std::ptr::null_mut::<AnyObject>()];
                }
                if let Some(menu) = &tray.menu {
                    let _: () = msg_send![&*tray.status_item, setMenu: &**menu];
                }
                let icon = mode_icon(tray.mode);
                set_button_image(tray, icon);
            }
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
        cx.spawn(async move |cx| {
            let previous = cx
                .background_executor()
                .spawn(async { scan_previous(true) })
                .await;
            cx.update(|cx| {
                if !cx.has_global::<Tray>() {
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
        build_menu(tray.mode, &tray.previous, menus::app_version())
    }
}

#[cfg(not(target_os = "macos"))]
mod stub {
    use gpui::App;

    use super::{Entry, PreviousItem};

    pub fn init(_cx: &mut App) {}
    pub fn rebuild(_cx: &mut App) {}
    pub fn set_recording(_recording: bool, _cx: &mut App) {}
    pub fn mode_changed(_mode: crate::main_window::Mode, _cx: &mut App) {}
    pub fn refresh_previous(_cx: &mut App) {}
    pub fn previous_items(_cx: &App) -> Vec<PreviousItem> {
        Vec::new()
    }
    pub fn menu_snapshot(_cx: &App) -> Vec<Entry> {
        Vec::new()
    }
}

#[cfg(not(target_os = "macos"))]
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

    fn titles(entries: &[Entry]) -> Vec<String> {
        entries
            .iter()
            .map(|entry| match entry {
                Entry::Separator => "-".to_string(),
                Entry::Item { title, .. } => title.clone(),
                Entry::Submenu { title, .. } => title.clone(),
            })
            .collect()
    }

    #[test]
    fn menu_matches_build_tray_menu() {
        let menu = build_menu(Mode::Studio, &[], "0.1.0");
        assert_eq!(
            titles(&menu),
            vec![
                "Open Main Window",
                "Record Display",
                "Record Window",
                "Record Area",
                "Take a Screenshot",
                "Import Media...",
                "-",
                "Select Mode",
                "Previous",
                "-",
                "View all recordings",
                "View all screenshots",
                "Settings",
                "-",
                "Upload Logs",
                "Cap v0.1.0",
                "Quit Cap",
            ]
        );
    }

    /// Screenshot mode relabels the three target rows and drops "Take a
    /// Screenshot" entirely.
    #[test]
    fn screenshot_mode_relabels_the_capture_rows() {
        let menu = build_menu(Mode::Screenshot, &[], "0.1.0");
        let titles = titles(&menu);
        assert_eq!(
            &titles[..6],
            &[
                "Open Main Window",
                "Screenshot Display",
                "Screenshot Window",
                "Screenshot Area",
                "Import Media...",
                "-",
            ]
        );
        assert!(!titles.iter().any(|title| title == "Take a Screenshot"));
    }

    #[test]
    fn the_current_mode_is_ticked() {
        for (mode, expected) in [
            (Mode::Studio, ["\u{2713} Studio", "   Instant", "   Screenshot"]),
            (Mode::Instant, ["   Studio", "\u{2713} Instant", "   Screenshot"]),
            (
                Mode::Screenshot,
                ["   Studio", "   Instant", "\u{2713} Screenshot"],
            ),
        ] {
            let Entry::Submenu { items, .. } = mode_submenu(mode) else {
                panic!("Select Mode is a submenu");
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
            (MediaKind::Studio, "Screen Recording", "\u{1f3ac} Screen Recording"),
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

    /// Only the rows with a real handler are enabled; the four deviations are
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
            vec![
                "Take a Screenshot",
                "Import Media...",
                "Upload Logs",
                "Cap v0.1.0",
            ]
        );
    }
}
