use crate::{
    App, NewScreenshotAdded, NewStudioRecordingAdded, RecordingStarted, RecordingStopped,
    RequestOpenSettings, recording,
    recording_settings::{RecordingSettingsStore, RecordingTargetMode},
    windows::ShowCapWindow,
};
use cap_recording::RecordingMode;

use cap_project::{RecordingMeta, RecordingMetaInner};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::Manager;
use tauri::menu::{IconMenuItem, MenuId, PredefinedMenuItem, Submenu};
use tauri::{
    AppHandle,
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_specta::Event;

const PREVIOUS_ITEM_PREFIX: &str = "previous_item_";
const MAX_PREVIOUS_ITEMS: usize = 6;
const MAX_TITLE_LENGTH: usize = 30;
const THUMBNAIL_SIZE: u32 = 32;

#[derive(Debug)]
pub enum TrayItem {
    OpenCap,
    RecordDisplay,
    RecordWindow,
    RecordArea,
    TakeScreenshot,
    ImportVideo,
    ViewAllRecordings,
    ViewAllScreenshots,
    OpenSettings,
    UploadLogs,
    Quit,
    PreviousItem(String),
    ModeStudio,
    ModeInstant,
    ModeScreenshot,
    RequestPermissions,
}

impl From<TrayItem> for MenuId {
    fn from(value: TrayItem) -> Self {
        match value {
            TrayItem::OpenCap => "open_cap",
            TrayItem::RecordDisplay => "record_display",
            TrayItem::RecordWindow => "record_window",
            TrayItem::RecordArea => "record_area",
            TrayItem::TakeScreenshot => "take_screenshot",
            TrayItem::ImportVideo => "import_video",
            TrayItem::ViewAllRecordings => "view_all_recordings",
            TrayItem::ViewAllScreenshots => "view_all_screenshots",
            TrayItem::OpenSettings => "open_settings",
            TrayItem::UploadLogs => "upload_logs",
            TrayItem::Quit => "quit",
            TrayItem::PreviousItem(id) => {
                return format!("{PREVIOUS_ITEM_PREFIX}{id}").into();
            }
            TrayItem::ModeStudio => "mode_studio",
            TrayItem::ModeInstant => "mode_instant",
            TrayItem::ModeScreenshot => "mode_screenshot",
            TrayItem::RequestPermissions => "request_permissions",
        }
        .into()
    }
}

impl TryFrom<MenuId> for TrayItem {
    type Error = String;

    fn try_from(value: MenuId) -> Result<Self, Self::Error> {
        let id_str = value.0.as_str();

        if let Some(path) = id_str.strip_prefix(PREVIOUS_ITEM_PREFIX) {
            return Ok(TrayItem::PreviousItem(path.to_string()));
        }

        match id_str {
            "open_cap" => Ok(TrayItem::OpenCap),
            "record_display" => Ok(TrayItem::RecordDisplay),
            "record_window" => Ok(TrayItem::RecordWindow),
            "record_area" => Ok(TrayItem::RecordArea),
            "take_screenshot" => Ok(TrayItem::TakeScreenshot),
            "import_video" => Ok(TrayItem::ImportVideo),
            "view_all_recordings" => Ok(TrayItem::ViewAllRecordings),
            "view_all_screenshots" => Ok(TrayItem::ViewAllScreenshots),
            "open_settings" => Ok(TrayItem::OpenSettings),
            "upload_logs" => Ok(TrayItem::UploadLogs),
            "quit" => Ok(TrayItem::Quit),
            "mode_studio" => Ok(TrayItem::ModeStudio),
            "mode_instant" => Ok(TrayItem::ModeInstant),
            "mode_screenshot" => Ok(TrayItem::ModeScreenshot),
            "request_permissions" => Ok(TrayItem::RequestPermissions),
            value => Err(format!("Invalid tray item id {value}")),
        }
    }
}

#[derive(Debug, Clone)]
enum PreviousItemType {
    StudioRecording,
    InstantRecording {
        #[allow(dead_code)]
        link: Option<String>,
    },
    Screenshot,
}

#[derive(Clone)]
struct CachedPreviousItem {
    path: PathBuf,
    pretty_name: String,
    thumbnail: Option<Vec<u8>>,
    thumbnail_width: u32,
    thumbnail_height: u32,
    item_type: PreviousItemType,
    created_at: std::time::SystemTime,
}

#[derive(Default)]
struct PreviousItemsCache {
    items: Vec<CachedPreviousItem>,
}

fn recordings_path(app: &AppHandle) -> PathBuf {
    let path = app.path().app_data_dir().unwrap().join("recordings");
    std::fs::create_dir_all(&path).unwrap_or_default();
    path
}

fn screenshots_path(app: &AppHandle) -> PathBuf {
    let path = app.path().app_data_dir().unwrap().join("screenshots");
    std::fs::create_dir_all(&path).unwrap_or_default();
    path
}

fn truncate_title(title: &str) -> String {
    if title.chars().count() <= MAX_TITLE_LENGTH {
        title.to_string()
    } else {
        let truncate_at = MAX_TITLE_LENGTH - 1;
        let byte_index = title
            .char_indices()
            .nth(truncate_at)
            .map(|(i, _)| i)
            .unwrap_or(title.len());
        format!("{}…", &title[..byte_index])
    }
}

fn load_thumbnail_data(path: &PathBuf) -> Option<(Vec<u8>, u32, u32)> {
    use image::imageops::FilterType;
    use image::{GenericImageView, RgbaImage};

    let image_data = std::fs::read(path).ok()?;
    let img = image::load_from_memory(&image_data).ok()?;

    let (orig_w, orig_h) = img.dimensions();
    let size = THUMBNAIL_SIZE;

    let scale = (size as f32 / orig_w as f32).max(size as f32 / orig_h as f32);
    let scaled_w = (orig_w as f32 * scale).round() as u32;
    let scaled_h = (orig_h as f32 * scale).round() as u32;

    let scaled = img.resize_exact(scaled_w, scaled_h, FilterType::Triangle);

    let x_offset = (scaled_w.saturating_sub(size)) / 2;
    let y_offset = (scaled_h.saturating_sub(size)) / 2;

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

    Some((result.into_raw(), size, size))
}

fn load_single_item(
    path: &PathBuf,
    screenshots_dir: &PathBuf,
    load_thumbnail: bool,
) -> Option<CachedPreviousItem> {
    if !path.is_dir() {
        return None;
    }

    let meta = RecordingMeta::load_for_project(path).ok()?;
    let created_at = path
        .metadata()
        .and_then(|m| m.created())
        .unwrap_or_else(|_| std::time::SystemTime::now());

    let is_screenshot = path.extension().and_then(|s| s.to_str()) == Some("cap")
        && path.parent().map(|p| p == screenshots_dir).unwrap_or(false);

    let (thumbnail_path, item_type) = if is_screenshot {
        let png_path = std::fs::read_dir(path).ok().and_then(|dir| {
            dir.flatten()
                .find(|e| e.path().extension().and_then(|s| s.to_str()) == Some("png"))
                .map(|e| e.path())
        });
        (png_path, PreviousItemType::Screenshot)
    } else {
        let thumb = path.join("screenshots/display.jpg");
        let thumb_path = if thumb.exists() { Some(thumb) } else { None };
        let item_type = match &meta.inner {
            RecordingMetaInner::Studio(_) => PreviousItemType::StudioRecording,
            RecordingMetaInner::Instant(_) => PreviousItemType::InstantRecording {
                link: meta.sharing.as_ref().map(|s| s.link.clone()),
            },
        };
        (thumb_path, item_type)
    };

    let (thumbnail, thumbnail_width, thumbnail_height) = if load_thumbnail {
        thumbnail_path
            .as_ref()
            .and_then(load_thumbnail_data)
            .map(|(data, w, h)| (Some(data), w, h))
            .unwrap_or((None, 0, 0))
    } else {
        (None, 0, 0)
    };

    Some(CachedPreviousItem {
        path: path.clone(),
        pretty_name: meta.pretty_name,
        thumbnail,
        thumbnail_width,
        thumbnail_height,
        item_type,
        created_at,
    })
}

fn load_all_previous_items(app: &AppHandle, load_thumbnails: bool) -> Vec<CachedPreviousItem> {
    let mut items = Vec::new();
    let screenshots_dir = screenshots_path(app);

    let recordings_dir = recordings_path(app);
    if recordings_dir.exists()
        && let Ok(entries) = std::fs::read_dir(&recordings_dir)
    {
        for entry in entries.flatten() {
            if let Some(item) = load_single_item(&entry.path(), &screenshots_dir, load_thumbnails) {
                items.push(item);
            }
        }
    }

    if screenshots_dir.exists()
        && let Ok(entries) = std::fs::read_dir(&screenshots_dir)
    {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("cap")
                && let Some(item) = load_single_item(&path, &screenshots_dir, load_thumbnails)
            {
                items.push(item);
            }
        }
    }

    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    items.truncate(MAX_PREVIOUS_ITEMS);
    items
}

fn create_previous_submenu(
    app: &AppHandle,
    cache: &PreviousItemsCache,
) -> tauri::Result<Submenu<tauri::Wry>> {
    if cache.items.is_empty() {
        let submenu = Submenu::with_id(app, "previous", "Previous", false)?;
        submenu.append(&MenuItem::with_id(
            app,
            "previous_empty",
            "No recent items",
            false,
            None::<&str>,
        )?)?;
        return Ok(submenu);
    }

    let submenu = Submenu::with_id(app, "previous", "Previous", true)?;

    for item in &cache.items {
        let id = TrayItem::PreviousItem(item.path.to_string_lossy().to_string());
        let title = truncate_title(&item.pretty_name);

        let type_indicator = match &item.item_type {
            PreviousItemType::StudioRecording => "🎬 ",
            PreviousItemType::InstantRecording { .. } => "⚡ ",
            PreviousItemType::Screenshot => "📷 ",
        };
        let display_title = format!("{type_indicator}{title}");

        let icon = item.thumbnail.as_ref().map(|data| {
            Image::new_owned(data.clone(), item.thumbnail_width, item.thumbnail_height)
        });

        let menu_item = IconMenuItem::with_id(app, id, display_title, true, icon, None::<&str>)?;
        submenu.append(&menu_item)?;
    }

    Ok(submenu)
}

fn get_current_mode(app: &AppHandle) -> RecordingMode {
    RecordingSettingsStore::get(app)
        .ok()
        .flatten()
        .and_then(|s| s.mode)
        .unwrap_or_default()
}

fn is_setup_window_open(app: &AppHandle) -> bool {
    app.webview_windows().contains_key("setup")
}

fn create_mode_submenu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let current_mode = get_current_mode(app);

    let submenu = Submenu::with_id(app, "select_mode", "Select Mode", true)?;

    let modes = [
        (TrayItem::ModeStudio, RecordingMode::Studio, "Studio"),
        (TrayItem::ModeInstant, RecordingMode::Instant, "Instant"),
        (
            TrayItem::ModeScreenshot,
            RecordingMode::Screenshot,
            "Screenshot",
        ),
    ];

    for (tray_item, mode, label) in modes {
        let is_selected = current_mode == mode;
        let display_label = if is_selected {
            format!("✓ {label}")
        } else {
            format!("   {label}")
        };

        let menu_item = MenuItem::with_id(app, tray_item, display_label, true, None::<&str>)?;
        submenu.append(&menu_item)?;
    }

    Ok(submenu)
}

fn build_tray_menu(app: &AppHandle, cache: &PreviousItemsCache) -> tauri::Result<Menu<tauri::Wry>> {
    if is_setup_window_open(app) {
        return Menu::with_items(
            app,
            &[
                &MenuItem::with_id(
                    app,
                    TrayItem::RequestPermissions,
                    "Request Permissions",
                    true,
                    None::<&str>,
                )?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(
                    app,
                    "version",
                    format!("Cap v{}", env!("CARGO_PKG_VERSION")),
                    false,
                    None::<&str>,
                )?,
                &MenuItem::with_id(app, TrayItem::Quit, "Quit Cap", true, None::<&str>)?,
            ],
        );
    }

    let previous_submenu = create_previous_submenu(app, cache)?;
    let mode_submenu = create_mode_submenu(app)?;
    let current_mode = get_current_mode(app);
    let is_screenshot_mode = current_mode == RecordingMode::Screenshot;

    let menu = Menu::new(app)?;

    menu.append(&MenuItem::with_id(
        app,
        TrayItem::OpenCap,
        "Open Main Window",
        true,
        None::<&str>,
    )?)?;

    if is_screenshot_mode {
        menu.append(&MenuItem::with_id(
            app,
            TrayItem::RecordDisplay,
            "Screenshot Display",
            true,
            None::<&str>,
        )?)?;
        menu.append(&MenuItem::with_id(
            app,
            TrayItem::RecordWindow,
            "Screenshot Window",
            true,
            None::<&str>,
        )?)?;
        menu.append(&MenuItem::with_id(
            app,
            TrayItem::RecordArea,
            "Screenshot Area",
            true,
            None::<&str>,
        )?)?;
    } else {
        menu.append(&MenuItem::with_id(
            app,
            TrayItem::RecordDisplay,
            "Record Display",
            true,
            None::<&str>,
        )?)?;
        menu.append(&MenuItem::with_id(
            app,
            TrayItem::RecordWindow,
            "Record Window",
            true,
            None::<&str>,
        )?)?;
        menu.append(&MenuItem::with_id(
            app,
            TrayItem::RecordArea,
            "Record Area",
            true,
            None::<&str>,
        )?)?;
        menu.append(&MenuItem::with_id(
            app,
            TrayItem::TakeScreenshot,
            "Take a Screenshot",
            true,
            None::<&str>,
        )?)?;
    }

    menu.append(&MenuItem::with_id(
        app,
        TrayItem::ImportVideo,
        "Import Video...",
        true,
        None::<&str>,
    )?)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&mode_submenu)?;
    menu.append(&previous_submenu)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    menu.append(&MenuItem::with_id(
        app,
        TrayItem::ViewAllRecordings,
        "View all recordings",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        TrayItem::ViewAllScreenshots,
        "View all screenshots",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        TrayItem::OpenSettings,
        "Settings",
        true,
        None::<&str>,
    )?)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        TrayItem::UploadLogs,
        "Upload Logs",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "version",
        format!("Cap v{}", env!("CARGO_PKG_VERSION")),
        false,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        TrayItem::Quit,
        "Quit Cap",
        true,
        None::<&str>,
    )?)?;

    Ok(menu)
}

fn add_new_item_to_cache(cache: &Arc<Mutex<PreviousItemsCache>>, app: &AppHandle, path: PathBuf) {
    let screenshots_dir = screenshots_path(app);

    let Some(new_item) = load_single_item(&path, &screenshots_dir, true) else {
        return;
    };

    let mut cache_guard = cache.lock().unwrap();

    cache_guard.items.retain(|item| item.path != path);

    cache_guard.items.insert(0, new_item);

    cache_guard.items.truncate(MAX_PREVIOUS_ITEMS);
}

fn refresh_tray_menu(app: &AppHandle, cache: &Arc<Mutex<PreviousItemsCache>>) {
    let app_clone = app.clone();
    let cache_clone = cache.clone();

    let _ = app.run_on_main_thread(move || {
        let Some(tray) = app_clone.tray_by_id("tray") else {
            return;
        };

        let cache_guard = cache_clone.lock().unwrap();
        if let Ok(menu) = build_tray_menu(&app_clone, &cache_guard) {
            let _ = tray.set_menu(Some(menu));
        }
    });
}

fn handle_previous_item_click(app: &AppHandle, path_str: &str) {
    let path = PathBuf::from(path_str);

    let screenshots_dir = screenshots_path(app);
    let is_screenshot = path.extension().and_then(|s| s.to_str()) == Some("cap")
        && path.parent().map(|p| p == screenshots_dir).unwrap_or(false);

    if is_screenshot {
        let app = app.clone();
        let screenshot_path = path;
        tokio::spawn(async move {
            let _ = ShowCapWindow::ScreenshotEditor {
                path: screenshot_path,
            }
            .show(&app)
            .await;
        });
        return;
    }

    let meta = match RecordingMeta::load_for_project(&path) {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("Failed to load recording meta for previous item: {e}");
            return;
        }
    };

    match &meta.inner {
        RecordingMetaInner::Studio(_) => {
            let app = app.clone();
            let project_path = path.clone();
            tokio::spawn(async move {
                let _ = ShowCapWindow::Editor { project_path }.show(&app).await;
            });
        }
        RecordingMetaInner::Instant(_) => {
            if let Some(sharing) = &meta.sharing {
                let _ = app.opener().open_url(&sharing.link, None::<String>);
            } else {
                let mp4_path = path.join("content/output.mp4");
                if mp4_path.exists() {
                    let _ = app
                        .opener()
                        .open_path(mp4_path.to_str().unwrap_or_default(), None::<String>);
                }
            }
        }
    }
}

pub fn get_tray_icon() -> &'static [u8] {
    include_bytes!("../icons/tray-default-icon.png")
}

pub fn get_mode_icon(mode: RecordingMode) -> &'static [u8] {
    if cfg!(target_os = "windows") {
        return get_tray_icon();
    }
    match mode {
        RecordingMode::Studio => include_bytes!("../icons/tray-default-icon-studio.png"),
        RecordingMode::Instant => include_bytes!("../icons/tray-default-icon-instant.png"),
        RecordingMode::Screenshot => include_bytes!("../icons/tray-default-icon-screenshot.png"),
    }
}

pub fn update_tray_icon_for_mode(app: &AppHandle, mode: RecordingMode) {
    if cfg!(target_os = "windows") {
        return;
    }

    let Some(tray) = app.tray_by_id("tray") else {
        return;
    };

    if let Ok(icon) = Image::from_bytes(get_mode_icon(mode)) {
        let _ = tray.set_icon(Some(icon));
        let _ = tray.set_icon_as_template(true);
    }
}

fn handle_mode_selection(
    app: &AppHandle,
    mode: RecordingMode,
    cache: &Arc<Mutex<PreviousItemsCache>>,
) {
    if let Err(e) = RecordingSettingsStore::set_mode(app, mode) {
        tracing::error!("Failed to set recording mode: {e}");
        return;
    }

    update_tray_icon_for_mode(app, mode);
    refresh_tray_menu(app, cache);
}

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let items = load_all_previous_items(app, false);
    let cache = Arc::new(Mutex::new(PreviousItemsCache { items }));

    let menu = {
        let cache_guard = cache.lock().unwrap();
        build_tray_menu(app, &cache_guard)?
    };
    let app = app.clone();
    let is_recording = Arc::new(AtomicBool::new(false));

    let current_mode = get_current_mode(&app);
    let initial_icon = Image::from_bytes(get_mode_icon(current_mode))?;

    let _ = TrayIconBuilder::with_id("tray")
        .icon(initial_icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event({
            let app_handle = app.clone();
            let cache = cache.clone();
            move |app: &AppHandle, event| match TrayItem::try_from(event.id) {
                Ok(TrayItem::OpenCap) => {
                    let app = app.clone();
                    tokio::spawn(async move {
                        let _ = ShowCapWindow::Main {
                            init_target_mode: None,
                        }
                        .show(&app)
                        .await;
                    });
                }
                Ok(TrayItem::RecordDisplay) => {
                    let app = app.clone();
                    tokio::spawn(async move {
                        crate::open_target_picker(&app, RecordingTargetMode::Display).await;
                    });
                }
                Ok(TrayItem::RecordWindow) => {
                    let app = app.clone();
                    tokio::spawn(async move {
                        crate::open_target_picker(&app, RecordingTargetMode::Window).await;
                    });
                }
                Ok(TrayItem::RecordArea) => {
                    let app = app.clone();
                    tokio::spawn(async move {
                        crate::open_target_picker(&app, RecordingTargetMode::Area).await;
                    });
                }
                Ok(TrayItem::TakeScreenshot) => {
                    let app = app.clone();
                    tokio::spawn(async move {
                        use cap_recording::screen_capture::ScreenCaptureTarget;
                        use scap_targets::Display;

                        let display =
                            Display::get_containing_cursor().unwrap_or_else(Display::primary);
                        let target = ScreenCaptureTarget::Display { id: display.id() };

                        match recording::take_screenshot(app.clone(), target).await {
                            Ok(path) => {
                                let _ = ShowCapWindow::ScreenshotEditor { path }.show(&app).await;
                            }
                            Err(e) => {
                                tracing::error!("Failed to take screenshot: {e}");
                            }
                        }
                    });
                }
                Ok(TrayItem::ImportVideo) => {
                    let app = app.clone();
                    tokio::spawn(async move {
                        let file_path = app
                            .dialog()
                            .file()
                            .add_filter(
                                "Video Files",
                                &["mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v", "flv"],
                            )
                            .blocking_pick_file();

                        if let Some(file_path) = file_path {
                            let path = match file_path.into_path() {
                                Ok(p) => p,
                                Err(e) => {
                                    tracing::error!("Invalid file path: {e}");
                                    return;
                                }
                            };

                            match crate::import::start_video_import(app.clone(), path).await {
                                Ok(project_path) => {
                                    let _ = ShowCapWindow::Editor { project_path }.show(&app).await;
                                }
                                Err(e) => {
                                    tracing::error!("Failed to import video: {e}");
                                    app.dialog()
                                        .message(format!("Failed to import video: {e}"))
                                        .title("Import Error")
                                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                                        .blocking_show();
                                }
                            }
                        }
                    });
                }
                Ok(TrayItem::ViewAllRecordings) => {
                    let _ = RequestOpenSettings {
                        page: "recordings".to_string(),
                    }
                    .emit(&app_handle);
                }
                Ok(TrayItem::ViewAllScreenshots) => {
                    let _ = RequestOpenSettings {
                        page: "screenshots".to_string(),
                    }
                    .emit(&app_handle);
                }
                Ok(TrayItem::OpenSettings) => {
                    let app = app.clone();
                    tokio::spawn(
                        async move { ShowCapWindow::Settings { page: None }.show(&app).await },
                    );
                }
                Ok(TrayItem::UploadLogs) => {
                    let app = app.clone();
                    tokio::spawn(async move {
                        match crate::logging::upload_log_file(&app).await {
                            Ok(_) => {
                                tracing::info!("Successfully uploaded logs");
                                app.dialog()
                                    .message("Logs uploaded successfully")
                                    .show(|_| {});
                            }
                            Err(e) => {
                                tracing::error!("Failed to upload logs: {e:#}");
                                app.dialog().message("Failed to upload logs").show(|_| {});
                            }
                        }
                    });
                }
                Ok(TrayItem::Quit) => {
                    app.exit(0);
                }
                Ok(TrayItem::PreviousItem(path)) => {
                    handle_previous_item_click(app, &path);
                }
                Ok(TrayItem::ModeStudio) => {
                    handle_mode_selection(app, RecordingMode::Studio, &cache);
                }
                Ok(TrayItem::ModeInstant) => {
                    handle_mode_selection(app, RecordingMode::Instant, &cache);
                }
                Ok(TrayItem::ModeScreenshot) => {
                    handle_mode_selection(app, RecordingMode::Screenshot, &cache);
                }
                Ok(TrayItem::RequestPermissions) => {
                    let app = app.clone();
                    tokio::spawn(async move {
                        let _ = ShowCapWindow::Setup.show(&app).await;
                    });
                }
                _ => {}
            }
        })
        .on_tray_icon_event({
            let is_recording = Arc::clone(&is_recording);
            let app_handle = app.clone();
            move |tray, event| {
                if let tauri::tray::TrayIconEvent::Click { .. } = event {
                    let is_recording_now = is_recording.load(Ordering::Relaxed);
                    if is_recording_now {
                        let app = app_handle.clone();
                        tokio::spawn(async move {
                            let _ = recording::stop_recording(app.clone(), app.state()).await;
                        });
                    } else {
                        let app = app_handle.clone();
                        tokio::spawn(async move {
                            let state =
                                app.state::<Arc<tokio::sync::RwLock<App>>>().inner().clone();
                            if state.read().await.is_recording_active_or_pending() {
                                let _ = recording::stop_recording(app.clone(), app.state()).await;
                            }
                        });
                        let _ = tray.set_visible(true);
                    }
                }
            }
        })
        .build(&app);

    {
        let app_clone = app.clone();
        let cache_clone = cache.clone();
        std::thread::spawn(move || {
            let screenshots_dir = screenshots_path(&app_clone);
            let items_needing_thumbnails: Vec<PathBuf> = {
                let cache_guard = cache_clone.lock().unwrap();
                cache_guard
                    .items
                    .iter()
                    .filter(|item| item.thumbnail.is_none())
                    .map(|item| item.path.clone())
                    .collect()
            };

            if items_needing_thumbnails.is_empty() {
                return;
            }

            for path in items_needing_thumbnails {
                if let Some(updated_item) = load_single_item(&path, &screenshots_dir, true) {
                    let mut cache_guard = cache_clone.lock().unwrap();
                    if let Some(existing) = cache_guard.items.iter_mut().find(|i| i.path == path) {
                        existing.thumbnail = updated_item.thumbnail;
                        existing.thumbnail_width = updated_item.thumbnail_width;
                        existing.thumbnail_height = updated_item.thumbnail_height;
                    }
                }
            }

            let app_for_refresh = app_clone.clone();
            let cache_for_refresh = cache_clone.clone();
            let _ = app_clone.run_on_main_thread(move || {
                if let Some(tray) = app_for_refresh.tray_by_id("tray") {
                    let cache_guard = cache_for_refresh.lock().unwrap();
                    if let Ok(menu) = build_tray_menu(&app_for_refresh, &cache_guard) {
                        let _ = tray.set_menu(Some(menu));
                    }
                }
            });
        });
    }

    RecordingStarted::listen_any(&app, {
        let app = app.clone();
        let is_recording = is_recording.clone();
        move |_| {
            is_recording.store(true, Ordering::Relaxed);

            if cfg!(target_os = "windows") {
                return;
            }

            let Some(tray) = app.tray_by_id("tray") else {
                return;
            };

            if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/tray-stop-icon.png")) {
                let _ = tray.set_icon(Some(icon));
                let _ = tray.set_icon_as_template(true);
            }
        }
    });

    RecordingStopped::listen_any(&app, {
        let app_handle = app.clone();
        let is_recording = is_recording.clone();
        move |_| {
            is_recording.store(false, Ordering::Relaxed);

            if cfg!(target_os = "windows") {
                return;
            }

            let Some(tray) = app_handle.tray_by_id("tray") else {
                return;
            };

            let current_mode = get_current_mode(&app_handle);
            if let Ok(icon) = Image::from_bytes(get_mode_icon(current_mode)) {
                let _ = tray.set_icon(Some(icon));
                let _ = tray.set_icon_as_template(true);
            }
        }
    });

    NewStudioRecordingAdded::listen_any(&app, {
        let app_handle = app.clone();
        let cache_clone = cache.clone();
        move |event| {
            add_new_item_to_cache(&cache_clone, &app_handle, event.payload.path.clone());
            refresh_tray_menu(&app_handle, &cache_clone);
        }
    });

    NewScreenshotAdded::listen_any(&app, {
        let app_handle = app.clone();
        let cache_clone = cache.clone();
        move |event| {
            let path = if event.payload.path.extension().and_then(|s| s.to_str()) == Some("png") {
                event.payload.path.parent().map(|p| p.to_path_buf())
            } else {
                Some(event.payload.path.clone())
            };

            if let Some(path) = path {
                add_new_item_to_cache(&cache_clone, &app_handle, path);
                refresh_tray_menu(&app_handle, &cache_clone);
            }
        }
    });

    Ok(())
}
