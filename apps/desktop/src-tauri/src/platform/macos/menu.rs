#![allow(non_snake_case)]

use objc2::runtime::{AnyObject, Sel};
use objc2::{MainThreadMarker, sel};
use objc2_app_kit::NSApplication;
use tauri::AppHandle;
use tauri::menu::{
    HELP_SUBMENU_ID, Menu, MenuItem, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID,
};
use tauri_plugin_opener::OpenerExt;

use crate::spawn_on_runtime;
use crate::windows::CapWindow;

const APP_MENU_QUIT_ID: &str = "app_quit";
static MACOS_NATIVE_TERMINATE_APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let _ = MACOS_NATIVE_TERMINATE_APP.set(app.clone());

    app.run_on_main_thread(|| {
        let mtm = MainThreadMarker::new().expect("Running on main");
        let nsapp = NSApplication::sharedApplication(mtm);

        unsafe { setup_terminate_handler(&nsapp) };
        patch_native_app_menu(&nsapp);
    })
}

fn patch_native_app_menu(nsapp: &NSApplication) {
    let Some(main_menu) = nsapp.mainMenu() else {
        return;
    };

    // First item in the menu bar is always the app menu on macOS
    let Some(app_menu_item) = main_menu.itemAtIndex(0) else {
        return;
    };
    let Some(app_submenu) = app_menu_item.submenu() else {
        return;
    };

    // Index 0: About — replace Tauri's internal action with the real one.
    // This is what triggers the system About panel, including the app icon
    // display introduced in macOS 15.
    if let Some(about_item) = app_submenu.itemAtIndex(0) {
        unsafe {
            about_item.setAction(Some(sel!(orderFrontStandardAboutPanel:)));
            // nil target means the action travels up the responder chain to NSApp
            about_item.setTarget(None);
        }
    }

    // Quit (last item) — native terminate: gets the icon on macOS 15+
    // and routes through applicationShouldTerminate: which we already own
    let last = app_submenu.numberOfItems() - 1;
    if let Some(item) = app_submenu.itemAtIndex(last) {
        unsafe {
            item.setAction(Some(sel!(terminate:)));
            item.setTarget(None); // nil = travels to NSApp via responder chain
        }
    }
}

unsafe fn setup_terminate_handler(nsapp: &NSApplication) {
    let Some(delegate) = nsapp.delegate() else {
        tracing::warn!("Unable to install macOS native termination handler without app delegate");
        return;
    };

    let delegate_class = (delegate.as_ref() as &objc2::runtime::AnyObject).class() as *const _
        as *mut objc2::runtime::AnyClass;

    unsafe extern "C-unwind" fn applicationShouldTerminate(
        _: &objc2::runtime::AnyObject,
        _: objc2::runtime::Sel,
        _: *mut objc2::runtime::AnyObject,
    ) -> isize {
        match MACOS_NATIVE_TERMINATE_APP.get() {
            Some(app) => {
                tokio::spawn({
                    let app = app.clone();
                    async move {
                        crate::request_app_exit(app).await;
                    }
                });
            }
            None => {
                tracing::warn!("macOS native termination requested before handler was installed");
            }
        };
        0 // NSTerminateCancel — we handle the actual exit ourselves
    }

    let added = unsafe {
        objc2::ffi::class_addMethod(
            delegate_class,
            sel!(applicationShouldTerminate:),
            std::mem::transmute::<
                unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> isize,
                unsafe extern "C-unwind" fn(),
            >(applicationShouldTerminate),
            c"q@:@".as_ptr(), // NSInteger
        )
    };

    if added.as_bool() {
        tracing::info!("Installed macOS native termination handler");
    } else {
        tracing::warn!("macOS native termination handler was already installed");
    }
}

pub fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[
            &MenuItem::with_id(app, "help.changelog", "Changelog", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "help.dashboard", "Dashboard", true, None::<&str>)?,
            &MenuItem::with_id(app, "help.docs", "Documentation", true, None::<&str>)?,
            &MenuItem::with_id(app, "help.faq", "FAQ", true, None::<&str>)?,
            &MenuItem::with_id(app, "help.self_hosting", "Self-hosting", true, None::<&str>)?,
            &MenuItem::with_id(app, "help.help_center", "Help Center", true, None::<&str>)?,
            &MenuItem::with_id(app, "help.status", "System Status", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "help.discord",
                "Join Discord Community",
                true,
                None::<&str>,
            )?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                app.package_info().name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    // Using this exact name and acceletator combination on macOS 15+ gets the item to have an auto translatable name and an icon
                    &MenuItem::with_id(app, "settings", "Preferences…", true, Some("Cmd+,"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[&PredefinedMenuItem::close_window(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )
}

pub fn on_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let url = match event.id().as_ref() {
        APP_MENU_QUIT_ID => {
            let app = app.clone();
            tokio::spawn(async move {
                crate::request_app_exit(app).await;
            });
            return;
        }
        "settings" => {
            let app = app.clone();
            spawn_on_runtime(async move {
                let _ = CapWindow::Settings { page: None }.show(&app).await;
            });
            return;
        }
        "help.changelog" => {
            let app = app.clone();
            spawn_on_runtime(async move {
                let _ = CapWindow::Settings {
                    page: Some("/changelog".to_string()),
                }
                .show(&app)
                .await;
            });
            return;
        }
        "help.dashboard" => "https://cap.so/dashboard",
        "help.docs" => "https://cap.so/docs",
        "help.faq" => "https://cap.so/faq",
        "help.self_hosting" => "https://cap.so/self-hosting",
        "help.help_center" => "https://help.cap.so/",
        "help.status" => "https://cap.openstatus.dev/",
        "help.discord" => "https://discord.gg/y8gdQ3WRN3",
        _ => return,
    };

    let _ = app.opener().open_url(url, None::<&str>);
}
