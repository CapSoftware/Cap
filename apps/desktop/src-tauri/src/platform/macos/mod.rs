use dispatch2::run_on_main;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowCollectionBehavior, NSWindowLevel};
use tauri::WebviewWindow;

mod sc_shareable_content;

pub use sc_shareable_content::*;

pub trait WebviewWindowExt {
    fn objc2_nswindow(&self) -> &NSWindow;

    fn set_window_buttons_visible(&self, visible: bool);

    fn set_level(&self, level: NSWindowLevel);

    fn disable_fullscreen(&self);
}

impl WebviewWindowExt for WebviewWindow {
    #[inline]
    fn objc2_nswindow(&self) -> &NSWindow {
        // SAFETY: This cast is safe as the existence of the WebviewWindow means it's attached to an NSWindow
        unsafe {
            &*self
                .ns_window()
                .expect("WebviewWindow is always backed by NSWindow")
                .cast()
        }
    }

    fn set_window_buttons_visible(&self, visible: bool) {
        run_on_main(move |_| {
            let nswindow = self.objc2_nswindow();
            for btn in [
                NSWindowButton::CloseButton,
                NSWindowButton::MiniaturizeButton,
                NSWindowButton::ZoomButton,
            ] {
                if let Some(btn) = nswindow.standardWindowButton(btn) {
                    btn.setHidden(!visible);
                }
            }
        });
    }

    fn set_level(&self, level: NSWindowLevel) {
        run_on_main(move |_| self.objc2_nswindow().setLevel(level));
    }

    fn disable_fullscreen(&self) {
        run_on_main(move |_| {
            let window = self.objc2_nswindow();
            window.setCollectionBehavior(
                window.collectionBehavior() | NSWindowCollectionBehavior::FullScreenNone,
            );
        });
    }
}
