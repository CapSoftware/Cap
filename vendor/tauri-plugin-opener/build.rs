// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::path::PathBuf;

#[path = "src/scope_entry.rs"]
#[allow(dead_code)]
mod scope;

/// Opener scope application.
#[derive(schemars::JsonSchema)]
#[serde(untagged)]
#[allow(unused)]
enum Application {
    /// Open in default application.
    Default,
    /// If true, allow open with any application.
    Enable(bool),
    /// Allow specific application to open with.
    App(String),
}

impl Default for Application {
    fn default() -> Self {
        Self::Default
    }
}

/// Opener scope entry.
#[derive(schemars::JsonSchema)]
#[serde(untagged)]
#[allow(unused)]
enum OpenerScopeEntry {
    Url {
        /// A URL that can be opened by the webview when using the Opener APIs.
        ///
        /// Wildcards can be used following the UNIX glob pattern.
        ///
        /// Examples:
        ///
        /// - "https://*" : allows all HTTPS origin
        ///
        /// - "https://*.github.com/tauri-apps/tauri": allows any subdomain of "github.com" with the "tauri-apps/api" path
        ///
        /// - "https://myapi.service.com/users/*": allows access to any URLs that begins with "https://myapi.service.com/users/"
        url: String,
        /// An application to open this url with, for example: firefox.
        #[serde(default)]
        app: Application,
    },
    Path {
        /// A path that can be opened by the webview when using the Opener APIs.
        ///
        /// The pattern can start with a variable that resolves to a system base directory.
        /// The variables are: `$AUDIO`, `$CACHE`, `$CONFIG`, `$DATA`, `$LOCALDATA`, `$DESKTOP`,
        /// `$DOCUMENT`, `$DOWNLOAD`, `$EXE`, `$FONT`, `$HOME`, `$PICTURE`, `$PUBLIC`, `$RUNTIME`,
        /// `$TEMPLATE`, `$VIDEO`, `$RESOURCE`, `$APP`, `$LOG`, `$TEMP`, `$APPCONFIG`, `$APPDATA`,
        /// `$APPLOCALDATA`, `$APPCACHE`, `$APPLOG`.
        path: PathBuf,
        /// An application to open this path with, for example: xdg-open.
        #[serde(default)]
        app: Application,
    },
}

// Ensure `OpenerScopeEntry` and `scope::EntryRaw` is kept in sync
fn _f() {
    match (scope::EntryRaw::Url {
        url: String::new(),
        app: scope::Application::Enable(true),
    }) {
        scope::EntryRaw::Url { url, app } => OpenerScopeEntry::Url {
            url,
            app: match app {
                scope::Application::Enable(p) => Application::Enable(p),
                scope::Application::App(p) => Application::App(p),
                scope::Application::Default => Application::Default,
            },
        },
        scope::EntryRaw::Path { path, app } => OpenerScopeEntry::Path {
            path,
            app: match app {
                scope::Application::Enable(p) => Application::Enable(p),
                scope::Application::App(p) => Application::App(p),
                scope::Application::Default => Application::Default,
            },
        },
    };
    match (OpenerScopeEntry::Url {
        url: String::new(),
        app: Application::Enable(true),
    }) {
        OpenerScopeEntry::Url { url, app } => scope::EntryRaw::Url {
            url,
            app: match app {
                Application::Enable(p) => scope::Application::Enable(p),
                Application::App(p) => scope::Application::App(p),
                Application::Default => scope::Application::Default,
            },
        },
        OpenerScopeEntry::Path { path, app } => scope::EntryRaw::Path {
            path,
            app: match app {
                Application::Enable(p) => scope::Application::Enable(p),
                Application::App(p) => scope::Application::App(p),
                Application::Default => scope::Application::Default,
            },
        },
    };
}

const COMMANDS: &[&str] = &["open_url", "open_path", "reveal_item_in_dir"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .global_api_script_path("./api-iife.js")
        .android_path("android")
        .ios_path("ios")
        .global_scope_schema(schemars::schema_for!(OpenerScopeEntry))
        .build();

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let mobile = target_os == "ios" || target_os == "android";
    alias("desktop", !mobile);
    alias("mobile", mobile);
}

// creates a cfg alias if `has_feature` is true.
// `alias` must be a snake case string.
fn alias(alias: &str, has_feature: bool) {
    println!("cargo:rustc-check-cfg=cfg({alias})");
    if has_feature {
        println!("cargo:rustc-cfg={alias}");
    }
}
