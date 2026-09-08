import { focusManager } from "@tanstack/solid-query";
import { getCurrentWindow } from "@tauri-apps/api/window";

export async function hideCurrentWindow() {
	const currentWindow = getCurrentWindow();
	await currentWindow.hide();
	if (currentWindow.label === "main") focusManager.setFocused(false);
}
