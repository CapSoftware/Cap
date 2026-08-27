use std::collections::HashMap;

use gpui::{App, Global};
use tray_icon::{
    Icon, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
    menu::{
        self, IconMenuItem, IsMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem,
        Submenu,
    },
};

use super::{
    Entry, PreviousItem, TrayItem, current_menu_entries, handle_item, scan_previous, stop_recording,
};
use crate::main_window::Mode;

const TRAY_ID: &str = "cap-gpui-tray";
const DEFAULT_ICON: &[u8] =
    include_bytes!("../../../desktop/src-tauri/icons/tray-default-icon.png");
const STOP_ICON: &[u8] = include_bytes!("../../assets/tray/tray-stop-icon.png");

enum Event {
    Menu(MenuId),
    Click,
}

struct NativeMenu {
    menu: Menu,
    actions: HashMap<MenuId, TrayItem>,
}

struct Tray {
    icon: TrayIcon,
    native_menu: NativeMenu,
    mode: Mode,
    previous: Vec<PreviousItem>,
    recording: bool,
    previous_generation: u64,
}

impl Global for Tray {}

pub fn init(cx: &mut App) {
    if cx.has_global::<Tray>() {
        return;
    }

    let mode = Mode::from_store();
    let entries = current_menu_entries(cx, mode, &[]);
    let tray = match create_tray(mode, &entries) {
        Ok(tray) => tray,
        Err(error) => {
            tracing::error!("failed to create the Windows tray: {error:#}");
            return;
        }
    };
    let (tx, rx) = flume::unbounded();
    let menu_tx = tx.clone();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let _ = menu_tx.send(Event::Menu(event.id));
    }));
    TrayIconEvent::set_event_handler(Some(move |event| {
        if activates_tray(&event) {
            let _ = tx.send(Event::Click);
        }
    }));
    cx.set_global(tray);

    cx.spawn(async move |cx| {
        while let Ok(event) = rx.recv_async().await {
            cx.update(|cx| {
                if !cx.has_global::<Tray>() {
                    return;
                }
                match event {
                    Event::Menu(id) => {
                        let item = cx.global::<Tray>().native_menu.actions.get(&id).cloned();
                        if let Some(item) = item {
                            handle_item(item, cx);
                        }
                    }
                    Event::Click => {
                        if cx.global::<Tray>().recording {
                            stop_recording(cx);
                        }
                    }
                }
            });
        }
    })
    .detach();

    refresh_previous(cx);
}

fn create_tray(mode: Mode, entries: &[Entry]) -> anyhow::Result<Tray> {
    let native_menu = build_native_menu(entries)?;
    let icon = TrayIconBuilder::new()
        .with_id(TRAY_ID)
        .with_tooltip("Cap")
        .with_icon(decode_tray_icon(DEFAULT_ICON)?)
        .with_menu(Box::new(native_menu.menu.clone()))
        .build()?;

    Ok(Tray {
        icon,
        native_menu,
        mode,
        previous: Vec::new(),
        recording: false,
        previous_generation: 0,
    })
}

fn activates_tray(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::Click {
            id,
            button_state: MouseButtonState::Up,
            ..
        } if id.as_ref() == TRAY_ID
    )
}

fn decode_tray_icon(bytes: &[u8]) -> anyhow::Result<Icon> {
    let image = image::load_from_memory(bytes)?.into_rgba8();
    let (width, height) = image.dimensions();
    Ok(Icon::from_rgba(image.into_raw(), width, height)?)
}

fn decode_menu_icon(bytes: &[u8]) -> anyhow::Result<menu::Icon> {
    let image = image::load_from_memory(bytes)?.into_rgba8();
    let (width, height) = image.dimensions();
    Ok(menu::Icon::from_rgba(image.into_raw(), width, height)?)
}

fn menu_text(title: &str) -> String {
    title.replace('&', "&&")
}

fn build_native_menu(entries: &[Entry]) -> anyhow::Result<NativeMenu> {
    let menu = Menu::new();
    let mut actions = HashMap::new();
    for entry in entries {
        let item = build_native_item(entry, &mut actions)?;
        menu.append(item.as_ref())?;
    }
    Ok(NativeMenu { menu, actions })
}

fn build_native_item(
    entry: &Entry,
    actions: &mut HashMap<MenuId, TrayItem>,
) -> anyhow::Result<Box<dyn IsMenuItem>> {
    match entry {
        Entry::Separator => Ok(Box::new(PredefinedMenuItem::separator())),
        Entry::Item {
            title,
            item,
            enabled,
            icon,
        } => {
            let icon = icon
                .as_deref()
                .and_then(|bytes| match decode_menu_icon(bytes) {
                    Ok(icon) => Some(icon),
                    Err(error) => {
                        tracing::warn!("failed to load a Windows tray thumbnail: {error:#}");
                        None
                    }
                });
            let enabled = *enabled && item.is_some();
            let native_item: Box<dyn IsMenuItem> = match icon {
                Some(icon) => Box::new(IconMenuItem::new(
                    menu_text(title),
                    enabled,
                    Some(icon),
                    None,
                )),
                None => Box::new(MenuItem::new(menu_text(title), enabled, None)),
            };
            if enabled && let Some(item) = item {
                let _ = actions.insert(native_item.id().clone(), item.clone());
            }
            Ok(native_item)
        }
        Entry::Submenu {
            title,
            enabled,
            items,
        } => {
            let submenu = Submenu::new(menu_text(title), *enabled);
            for entry in items {
                let item = build_native_item(entry, actions)?;
                submenu.append(item.as_ref())?;
            }
            Ok(Box::new(submenu))
        }
    }
}

pub fn set_recording(recording: bool, cx: &mut App) {
    if !cx.has_global::<Tray>() {
        return;
    }
    let tray = cx.global_mut::<Tray>();
    tray.recording = recording;
    if recording {
        tray.icon.set_menu(None);
    } else {
        tray.icon
            .set_menu(Some(Box::new(tray.native_menu.menu.clone())));
    }
    let bytes = if recording { STOP_ICON } else { DEFAULT_ICON };
    match decode_tray_icon(bytes) {
        Ok(icon) => {
            if let Err(error) = tray.icon.set_icon(Some(icon)) {
                tracing::warn!("failed to update the Windows tray icon: {error}");
            }
        }
        Err(error) => tracing::warn!("failed to decode the Windows tray icon: {error:#}"),
    }
    let tooltip = if recording {
        "Cap - Stop Recording"
    } else {
        "Cap"
    };
    if let Err(error) = tray.icon.set_tooltip(Some(tooltip)) {
        tracing::warn!("failed to update the Windows tray tooltip: {error}");
    }
}

pub fn mode_changed(mode: Mode, cx: &mut App) {
    if !cx.has_global::<Tray>() {
        return;
    }
    cx.global_mut::<Tray>().mode = mode;
    refresh_menu(cx);
}

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
            if !cx.has_global::<Tray>() || cx.global::<Tray>().previous_generation != generation {
                return;
            }
            cx.global_mut::<Tray>().previous = previous;
            refresh_menu(cx);
        });
    })
    .detach();
}

pub fn previous_items(cx: &App) -> Vec<PreviousItem> {
    if !cx.has_global::<Tray>() {
        return Vec::new();
    }
    cx.global::<Tray>().previous.clone()
}

pub fn menu_snapshot(cx: &App) -> Vec<Entry> {
    if !cx.has_global::<Tray>() {
        return Vec::new();
    }
    let tray = cx.global::<Tray>();
    current_menu_entries(cx, tray.mode, &tray.previous)
}

pub fn refresh_menu(cx: &mut App) {
    if !cx.has_global::<Tray>() {
        return;
    }
    let entries = menu_snapshot(cx);
    let native_menu = match build_native_menu(&entries) {
        Ok(menu) => menu,
        Err(error) => {
            tracing::warn!("failed to rebuild the Windows tray menu: {error:#}");
            return;
        }
    };
    let tray = cx.global_mut::<Tray>();
    if !tray.recording {
        tray.icon.set_menu(Some(Box::new(native_menu.menu.clone())));
    }
    tray.native_menu = native_menu;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tray_icon::{MouseButton, Rect};

    #[test]
    fn menu_titles_preserve_literal_ampersands() {
        assert_eq!(
            menu_text("Research & Development"),
            "Research && Development"
        );
        assert_eq!(menu_text("Studio"), "Studio");
    }

    #[test]
    fn recording_stop_uses_one_click_event_for_this_tray() {
        for button in [MouseButton::Left, MouseButton::Right, MouseButton::Middle] {
            let event = |id: &str, button_state| TrayIconEvent::Click {
                id: id.into(),
                position: Default::default(),
                rect: Rect::default(),
                button,
                button_state,
            };
            assert!(activates_tray(&event(TRAY_ID, MouseButtonState::Up)));
            assert!(!activates_tray(&event(TRAY_ID, MouseButtonState::Down)));
            assert!(!activates_tray(&event(
                "another-tray",
                MouseButtonState::Up
            )));
        }
        assert!(!activates_tray(&TrayIconEvent::DoubleClick {
            id: TRAY_ID.into(),
            position: Default::default(),
            rect: Rect::default(),
            button: MouseButton::Left,
        }));
    }
}
