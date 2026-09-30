// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::path::Path;

use tauri::{plugin::TauriPlugin, Manager, Runtime};

#[cfg(mobile)]
use tauri::plugin::PluginHandle;
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.tauri.opener";
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_opener);

mod commands;
mod config;
mod error;
mod open;
mod reveal_item_in_dir;
mod scope;
mod scope_entry;

pub use error::Error;
type Result<T> = std::result::Result<T, Error>;

pub use open::{open_path, open_url};
pub use reveal_item_in_dir::{reveal_item_in_dir, reveal_items_in_dir};

pub struct Opener<R: Runtime> {
    // we use `fn() -> R` to silence the unused generic error
    // while keeping this struct `Send + Sync` without requiring `R` to be
    #[cfg(not(mobile))]
    _marker: std::marker::PhantomData<fn() -> R>,
    #[cfg(mobile)]
    mobile_plugin_handle: PluginHandle<R>,
    require_literal_leading_dot: Option<bool>,
}

impl<R: Runtime> Opener<R> {
    /// Open a url with a default or specific program.
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// use tauri_plugin_opener::OpenerExt;
    ///
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     // open the given URL on the system default browser
    ///     app.opener().open_url("https://github.com/tauri-apps/tauri", None::<&str>)?;
    ///     Ok(())
    ///   });
    /// ```
    ///
    /// ## Platform-specific:
    ///
    /// - **Android / iOS**: Always opens using default program, unless `with` is provided as "inAppBrowser".
    #[cfg(desktop)]
    pub fn open_url(&self, url: impl Into<String>, with: Option<impl Into<String>>) -> Result<()> {
        crate::open::open(url.into(), with.map(Into::into))
    }

    /// Open a url with a default or specific program.
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// use tauri_plugin_opener::OpenerExt;
    ///
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     // open the given URL on the system default browser
    ///     app.opener().open_url("https://github.com/tauri-apps/tauri", None::<&str>)?;
    ///     Ok(())
    ///   });
    /// ```
    ///
    /// ## Platform-specific:
    ///
    /// - **Android / iOS**: Always opens using default program, unless `with` is provided as "inAppBrowser".
    #[cfg(mobile)]
    pub fn open_url(&self, url: impl Into<String>, with: Option<impl Into<String>>) -> Result<()> {
        self.mobile_plugin_handle
            .run_mobile_plugin(
                "open",
                serde_json::json!({ "url": url.into(), "with": with.map(Into::into) }),
            )
            .map_err(Into::into)
    }

    /// Open a path with a default or specific program.
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// use tauri_plugin_opener::OpenerExt;
    ///
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     // open the given path on the system default explorer
    ///     app.opener().open_path("/path/to/file", None::<&str>)?;
    ///     Ok(())
    ///   });
    /// ```
    ///
    /// ## Platform-specific:
    ///
    /// - **Android / iOS**: Always opens using default program.
    #[cfg(desktop)]
    pub fn open_path(
        &self,
        path: impl Into<String>,
        with: Option<impl Into<String>>,
    ) -> Result<()> {
        crate::open::open(path.into(), with.map(Into::into))
    }

    /// Open a path with a default or specific program.
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// use tauri_plugin_opener::OpenerExt;
    ///
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     // open the given path on the system default explorer
    ///     app.opener().open_path("/path/to/file", None::<&str>)?;
    ///     Ok(())
    ///   });
    /// ```
    ///
    /// ## Platform-specific:
    ///
    /// - **Android / iOS**: Always opens using default program.
    #[cfg(mobile)]
    pub fn open_path(
        &self,
        path: impl Into<String>,
        _with: Option<impl Into<String>>,
    ) -> Result<()> {
        self.mobile_plugin_handle
            .run_mobile_plugin("open", path.into())
            .map_err(Into::into)
    }

    pub fn reveal_item_in_dir<P: AsRef<Path>>(&self, p: P) -> Result<()> {
        reveal_item_in_dir(p)
    }

    pub fn reveal_items_in_dir<I, P>(&self, paths: I) -> Result<()>
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        reveal_items_in_dir(paths)
    }
}

/// Extensions to [`tauri::App`], [`tauri::AppHandle`], [`tauri::WebviewWindow`], [`tauri::Webview`] and [`tauri::Window`] to access the opener APIs.
pub trait OpenerExt<R: Runtime> {
    fn opener(&self) -> &Opener<R>;
}

impl<R: Runtime, T: Manager<R>> OpenerExt<R> for T {
    fn opener(&self) -> &Opener<R> {
        self.state::<Opener<R>>().inner()
    }
}

/// The opener plugin Builder.
pub struct Builder {
    open_js_links_on_click: bool,
}

impl Default for Builder {
    fn default() -> Self {
        Self {
            open_js_links_on_click: true,
        }
    }
}

impl Builder {
    /// Create a new opener plugin Builder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the plugin should inject a JS script to open URLs in default browser
    /// when clicking on `<a>` elements that has `_blank` target, or when pressing `Ctrl` or `Shift` while clicking it.
    ///
    /// Enabled by default for `http:`, `https:`, `mailto:`, `tel:` links.
    pub fn open_js_links_on_click(mut self, open: bool) -> Self {
        self.open_js_links_on_click = open;
        self
    }

    /// Build and Initializes the plugin.
    pub fn build<R: Runtime>(self) -> TauriPlugin<R, Option<config::Config>> {
        let mut builder = tauri::plugin::Builder::<R, Option<config::Config>>::new("opener")
            .setup(|app, api| {
                #[cfg(target_os = "android")]
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "OpenerPlugin")?;
                #[cfg(target_os = "ios")]
                let handle = api.register_ios_plugin(init_plugin_opener)?;

                app.manage(Opener {
                    #[cfg(not(mobile))]
                    _marker: std::marker::PhantomData::<fn() -> R>,
                    #[cfg(mobile)]
                    mobile_plugin_handle: handle,
                    require_literal_leading_dot: api
                        .config()
                        .as_ref()
                        .and_then(|c| c.require_literal_leading_dot),
                });
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                commands::open_url,
                commands::open_path,
                commands::reveal_item_in_dir,
            ]);

        if self.open_js_links_on_click {
            builder = builder.js_init_script(include_str!("init-iife.js").to_string());
        }

        builder.build()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R, Option<config::Config>> {
    Builder::default().build()
}
