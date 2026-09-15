# Cap changes to tauri-nspanel

Vendored from https://github.com/ahkohd/tauri-nspanel branch `v2` at
commit `18ffb9a201fbf6fedfaa382fd4b92315ea30ab1a` (crate version 2.0.1),
wired in through `[patch."https://github.com/ahkohd/tauri-nspanel"]` in the
workspace `Cargo.toml`. Only `src/` is patched; `macros.rs` is untouched.

## Why

Cap's target-select overlay crashed with `EXC_BAD_ACCESS` inside
`objc_autoreleasePoolPop` after a few open/close cycles. Two upstream bugs
combined:

1. `RawNSPanel::from_window` built its handle with `Id::from_retained_ptr`,
   claiming a +1 retain it never took. Tao still owned that retain, so every
   time the plugin dropped a handle it sent a real `release` to a window it did
   not own. `to_panel()` inserted a fresh handle into the label store on every
   call, dropping the previous one, so each repeat conversion of the same
   window stripped one retain. The overlay reveal path converts on every
   reveal, which reached zero within a handful of cycles.
2. The `dealloc` override sent `dealloc` to `NSObject`'s implementation
   (skipping `NSWindow`'s teardown) and then called the leftover x0 register
   as a function pointer. Any converted window that was ever freed jumped into
   malloc metadata, which is the bus error in the crash reports.

## Second bug found while soaking the fix: KVO vs `object_setClass`

Destroying any converted window that hosts a webview aborted the process with
`fatal runtime error: Rust cannot catch foreign exceptions`. The exception
(captured by the vendored tao's run-loop guard) is Foundation's
`NSRangeException: Cannot remove an observer <WKWindowVisibilityObserver> for
the key path "contentLayoutRect" from <RawNSPanel> because it is not
registered as an observer`. WebKit observes the window with KVO as soon as the
webview is attached; KVO does that by giving the window a dynamic
`NSKVONotifying_*` subclass; `object_setClass` to `RawNSPanel` discards that
subclass, so the observer removal at teardown throws. This is upstream
behaviour too (reproduced with the unpatched crate); it only needs a panel
window to be destroyed, e.g. the camera window when the camera is removed.

## What changed

- `RawNSPanel::from_window` / `from_ns_window` now take a real retain with
  `Id::from_ptr`. Tao's ownership is untouched; the store's handle is a +1 of
  its own.
- Conversion is idempotent. A window already re-classed to `RawNSPanel` skips
  the class swap, tracking area and autoresize setup, so repeat calls add no
  duplicate tracking areas.
- `WebviewWindowExt::to_panel` returns the stored handle when the same live
  window is converted again, replaces a stale entry left by an earlier window
  with the same label, and registers a `Destroyed` listener that drops the
  store entry so a closed window (and its webview) is not kept alive.
- `ManagerExt::remove_webview_panel` exposes explicit removal.
- The `dealloc` override is removed; `NSPanel`'s inherited chain is correct.
- `add_tracking_area` releases the `NSTrackingArea` it allocated once the view
  owns it.
- The class swap runs with the content subviews (the webview) detached and
  re-attached afterwards, so WebKit unregisters its observers against the old
  class and re-registers against the panel. `is_raw_panel` uses
  `isKindOfClass:` so a KVO-subclassed panel is never re-swapped.
- Store handle releases go through `objc_exception::try` and log the reason if
  AppKit throws, instead of unwinding through Rust.
- The vendored tao (`vendor/tao`) now catches Objective-C exceptions in its
  run-loop observer callback, logs them, and routes them through the normal
  panic path, so this class of failure is diagnosable from logs.

`NSPanel` and `NSWindow` have identical instance sizes (528 bytes, no extra
ivars on `NSPanel`), which is what makes the `object_setClass` swap safe.
