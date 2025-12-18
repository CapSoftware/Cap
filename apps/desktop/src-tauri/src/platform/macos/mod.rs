use objc2::{Message, rc::Retained};
use objc2_app_kit::{NSWindow, NSWindowButton};
use tauri::WebviewWindow;

mod sc_shareable_content;

pub use sc_shareable_content::*;

pub trait WebviewWindowExt {
    fn objc2_nswindow(&self) -> Retained<NSWindow>;

    fn set_traffic_lights_visible(&self, visible: bool);
}

impl WebviewWindowExt for WebviewWindow {
    #[inline]
    fn objc2_nswindow(&self) -> Retained<NSWindow> {
        // SAFETY: This cast is safe as the existence of the WebviewWindow means it's attached to an NSWindow
        unsafe {
            (&*self
                .ns_window()
                .expect("WebviewWindow is always backed by NSWindow")
                .cast::<NSWindow>())
                .retain()
        }
    }

    fn set_traffic_lights_visible(&self, visible: bool) {
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
    }
}
