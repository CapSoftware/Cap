Convert a Tauri `WebviewWindow` ([`NSWindow`](https://developer.apple.com/documentation/appkit/nswindow)) to panel ([`NSPanel`](https://developer.apple.com/documentation/appkit/nspanel))

# Install
Install the plugin by adding the following to your `Cargo.toml` file:

```toml
[dependencies]
tauri-nspanel = { git = "https://github.com/ahkohd/tauri-nspanel", branch = "v2" }

[features]
cargo-clippy = []
```

# Usage

1. First you need to register the core plugin with Tauri:

`src-tauri/src/main.rs`

```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_nspanel::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

2. To swizzle a window's `NSWindow` to `NSPanel`, use the `to_panel()` method:

```rust
use tauri_nspanel::WebviewWindowExt;

// ...
let panel = window.to_panel().unwrap();
```

The window will be swizzled to `NSPanel`.

> Only call the `to_panel()` method once on a webview window.

3. To access your panels, use the `app_handle.get_webview_panel("label")`:

```rust
use tauri_nspanel::ManagerExt;

// ...

let my_panel = app_handle.get_webview_panel("main");
```

4. To respond to panel events, such as resizing, moving, exposing, and minimizing ([See the exhaustive list](https://developer.apple.com/documentation/appkit/nswindowdelegate?language=objc)), you need to setup a `NSWindowDelegate` for your panel.

Use the `panel_delegate!()` macro to do this:

```rust
use tauri::Wry;
use tauri_nspanel::{objc_id::Id, panel_delegate, ManagerExt, Panel, WindowExt};

// ...
// Use the `panel_delegate!()` macro to create your custom delegate

// Specify your handlers
// See, https://developer.apple.com/documentation/appkit/nswindowdelegate?language=objc
// for an exhaustive list of handlers.
//
// Example: to respond to windowDidBecomeKey:
// specify in snake case: window_did_become_key

let delegate = panel_delegate!(MyPanelDelegate {
  window_did_become_key,
  window_did_resign_key
});

// Listen to when a delegate is called
delegate.set_listener(Box::new(|delegate_name: String| {
    println!("{} was called!", delegate_name);
}));

// Set your panel's delegate
panel.set_delegate(delegate);
```

5. Simply calling the `.close()` method on your NSPanel instance may not be sufficient to fully release its resources. This is because, by default,
   `NSPanels` are not released when they are closed. This is because NSPanels are often lightweight and designed for reuse.

To ensure that your NSPanel is fully released:

```rust
// ...

panel.set_released_when_closed(true);
panel.close();
```

6. See the [examples](/examples) to learn how to use `tauri-nspanel`. For more information on panel methods, please refer to the [documentation page](https://ahkohd.github.io/tauri-nspanel/tauri_nspanel/raw_nspanel/struct.RawNSPanel.html).

# Related

The following are projects related to this plugin:

- [tauri-plugin-spotlight](https://github.com/zzzze/tauri-plugin-spotlight)
- [tauri-macos-spotlight-example](https://github.com/ahkohd/tauri-macos-spotlight-example)
- [tauri-macos-menubar-example](https://github.com/ahkohd/tauri-macos-menubar-app-example)

# Showcase

Here are some projects using `tauri-nspanel`

- [Cap](https://github.com/CapSoftware/Cap)
- [EcoPaste](https://github.com/EcoPasteHub/EcoPaste)
- [Overlayed](https://github.com/overlayeddev/overlayed)
- [Lume](https://github.com/lumehq/lume)
- [Verve](https://github.com/ParthJadhav/verve)
- [Buffer](https://buffer.md)

# Contributing

PRs accepted. Please make sure to read the Contributing Guide before making a pull request.

# License

MIT or MIT/Apache 2.0 where applicable.
