mod sc_shareable_content;

use block2::RcBlock;
use objc2::{msg_send, sel};
use objc2_app_kit::NSWindow;
use objc2_foundation::NSObjectProtocol;
use objc2_web_kit::WKWebView;
pub use sc_shareable_content::*;
use tauri::WebviewWindow;

pub fn set_window_level(window: tauri::Window, level: objc2_app_kit::NSWindowLevel) {
    let c_window = window.clone();
    _ = window.run_on_main_thread(move || unsafe {
        let Ok(ns_win) = c_window.ns_window() else {
            return;
        };
        let ns_win = ns_win as *const objc2_app_kit::NSWindow;
        (*ns_win).setLevel(level);
    });
}

// pub trait WebviewWindowExt {
//     fn objc2_nswindow(&self) -> &NSWindow;
// }

// impl WebviewWindowExt for WebviewWindow {
//     #[inline]
//     fn objc2_nswindow(&self) -> &NSWindow {
//         // SAFETY: This cast is safe as long as we get a NSWindow from Tauri.
//         unsafe { &*self.ns_window().expect("NSWindow not ready").cast() }
//     }
// }

pub fn show_after_next_presentation_update(webview: &WebviewWindow) -> Result<(), tauri::Error> {
    webview.with_webview({
        let webview = webview.clone();
        move |wrywv| {
            let wv: &WKWebView = unsafe { &*wrywv.inner().cast() };
            let sel = sel!(_doAfterNextPresentationUpdate:);
            if wv.respondsToSelector(sel) {
                let block = RcBlock::new({
                    let webview = webview.clone();
                    move || {
                        _ = webview.show();
                    }
                });
                unsafe { msg_send![wv, _doAfterNextPresentationUpdate: &*block] }
            } else {
                _ = webview.show();
            }
        }
    })
}
