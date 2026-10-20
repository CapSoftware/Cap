#![allow(deprecated)]

mod macros;
pub mod raw_nspanel;

use std::{collections::HashMap, sync::Mutex};

use cocoa::base::id;
use objc_id::ShareId;
use raw_nspanel::RawNSPanel;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime, WebviewWindow,
};

pub extern crate block;
pub extern crate cocoa;
pub extern crate objc;
pub extern crate objc_foundation;
pub extern crate objc_id;
pub extern crate tauri;

pub type Panel = ShareId<RawNSPanel>;

#[derive(Default)]
pub struct Store {
    panels: HashMap<String, ShareId<RawNSPanel>>,
}

pub struct WebviewPanelManager(pub Mutex<Store>);

impl Default for WebviewPanelManager {
    fn default() -> Self {
        Self(Mutex::new(Store::default()))
    }
}

pub trait ManagerExt<R: Runtime> {
    fn get_webview_panel(&self, label: &str) -> Result<ShareId<RawNSPanel>, Error>;

    /// Drops the store's handle for `label`, releasing the retain the plugin
    /// took when the window was converted. Returns the handle so the caller
    /// can decide where it is dropped (the final release of an NSWindow must
    /// happen on the main thread).
    fn remove_webview_panel(&self, label: &str) -> Option<ShareId<RawNSPanel>>;
}

#[derive(Debug)]
pub enum Error {
    PanelNotFound,
}

impl<R: Runtime, T: Manager<R>> ManagerExt<R> for T {
    fn get_webview_panel(&self, label: &str) -> Result<ShareId<RawNSPanel>, Error> {
        let manager = self.state::<self::WebviewPanelManager>();
        let manager = manager.0.lock().unwrap();

        match manager.panels.get(label) {
            Some(panel) => Ok(panel.clone()),
            None => Err(Error::PanelNotFound),
        }
    }

    fn remove_webview_panel(&self, label: &str) -> Option<ShareId<RawNSPanel>> {
        let manager = self.state::<self::WebviewPanelManager>();
        let mut manager = manager.0.lock().unwrap();
        manager.panels.remove(label)
    }
}

#[derive(Default)]
pub struct WebviewPanelConfig {
    pub delegate: Option<id>,
}

pub trait WebviewWindowExt<R: Runtime> {
    fn to_panel(&self) -> tauri::Result<ShareId<RawNSPanel>>;
}

/// Releases a store handle on the main thread, turning an Objective-C
/// exception raised during the release (which would otherwise unwind through
/// tao's run-loop observer and abort the process) into a logged error.
fn release_panel_handle(context: &str, panel: ShareId<RawNSPanel>) {
    use objc::{msg_send, sel, sel_impl};

    let outcome = unsafe { objc_exception::r#try(move || drop(panel)) };
    if let Err(exception) = outcome {
        let exception = exception as id;
        let description = unsafe {
            let describe = |object: id| -> String {
                if object.is_null() {
                    return String::from("<nil>");
                }
                let utf8: *const std::os::raw::c_char = msg_send![object, UTF8String];
                if utf8.is_null() {
                    String::from("<non-utf8>")
                } else {
                    std::ffi::CStr::from_ptr(utf8)
                        .to_string_lossy()
                        .into_owned()
                }
            };
            if exception.is_null() {
                String::from("<unknown exception>")
            } else {
                let name: id = msg_send![exception, name];
                let reason: id = msg_send![exception, reason];
                format!("{}: {}", describe(name), describe(reason))
            }
        };
        eprintln!("tauri-nspanel: releasing panel handle ({context}) threw {description}");
    }
}

fn panel_ptr(panel: &ShareId<RawNSPanel>) -> usize {
    &**panel as *const RawNSPanel as usize
}

impl<R: Runtime> WebviewWindowExt<R> for WebviewWindow<R> {
    /// Converts the window's NSWindow into a `RawNSPanel` and stores a handle
    /// for it under the window label.
    ///
    /// Calling this again for the same live window returns the stored handle
    /// without touching the window: no second class swap, no duplicate
    /// tracking areas, and no change to the NSWindow's retain count. A stale
    /// entry left by a previous window with the same label is replaced, and
    /// the store forgets a window as soon as tao reports it destroyed, so the
    /// plugin never keeps a closed window (or its webview) alive.
    fn to_panel(&self) -> tauri::Result<ShareId<RawNSPanel>> {
        let nswindow = self.ns_window()? as id;
        let raw = nswindow as usize;
        let label = self.label().to_string();
        let manager = self.state::<self::WebviewPanelManager>();

        if let Some(existing) = manager.0.lock().unwrap().panels.get(&label) {
            if panel_ptr(existing) == raw {
                return Ok(existing.clone());
            }
        }

        // SAFETY: `ns_window()` handed us tao's live NSWindow, and tauri only
        // exposes it from the main thread context this is called in.
        let shared_panel = unsafe { RawNSPanel::from_ns_window(nswindow) }.share();

        let previous = manager
            .0
            .lock()
            .unwrap()
            .panels
            .insert(label.clone(), shared_panel.clone());
        // A different window that used this label before. Its handle holds a
        // real retain, so dropping it here (on the main thread) is the release
        // that lets AppKit finally free the old window.
        if let Some(previous) = previous {
            release_panel_handle("replacing stale label entry", previous);
        }

        let app = self.app_handle().clone();
        self.on_window_event(move |event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            let manager = app.state::<self::WebviewPanelManager>();
            let mut store = manager.0.lock().unwrap();
            let stale = match store.panels.get(&label) {
                Some(panel) if panel_ptr(panel) == raw => store.panels.remove(&label),
                _ => None,
            };
            drop(store);
            // Tao emits `Destroyed` from `windowWillClose:` on the main thread
            // while it still holds its own reference, so releasing ours here
            // never frees the window out from under AppKit.
            if let Some(stale) = stale {
                release_panel_handle("window destroyed", stale);
            }
        });

        Ok(shared_panel)
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("nspanel")
        .setup(|app, _api| {
            app.manage(self::WebviewPanelManager::default());

            Ok(())
        })
        .build()
}
