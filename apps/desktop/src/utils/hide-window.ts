import { focusManager } from "@tanstack/solid-query";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Counterpart of the Rust-side hide_main_window for hides initiated by the
// window's own frontend. An earlier blur (e.g. shell.open stealing focus)
// leaves a later hide invisible to the focus bridge, and
// document.visibilityState never flips on Windows (tauri-apps/tauri#9524),
// so the polling pause must be explicit.
export function hideCurrentWindow() {
	const currentWindow = getCurrentWindow();
	if (currentWindow.label === "main") focusManager.setFocused(false);
	return currentWindow.hide();
}
