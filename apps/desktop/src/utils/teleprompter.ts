import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type as ostype } from "@tauri-apps/plugin-os";
import { commands } from "./tauri";
import { getTeleprompterWindowOptions } from "./teleprompter-window-options";

export const TELEPROMPTER_WINDOW_LABEL = "teleprompter";

let creatingWindow: WebviewWindow | undefined;

async function cleanupFailedWindow(
	teleprompterWindow: WebviewWindow,
	openerWindow: WebviewWindow,
) {
	if (creatingWindow === teleprompterWindow) creatingWindow = undefined;
	await teleprompterWindow.destroy().catch(() => undefined);
	await openerWindow.setFocus().catch(() => undefined);
}

export async function openTeleprompter() {
	const existingWindow = await WebviewWindow.getByLabel(
		TELEPROMPTER_WINDOW_LABEL,
	);

	if (existingWindow) {
		if (ostype() !== "windows") {
			await commands.refreshWindowContentProtection();
			await existingWindow.unminimize();
			await existingWindow.show();
			await existingWindow.setFocus();
			return;
		}

		const openerWindow = WebviewWindow.getCurrent();
		try {
			await existingWindow.innerPosition();
			await existingWindow.unminimize();
			await existingWindow.show();
			await commands.refreshWindowContentProtection();
			await existingWindow.setFocus();
			return;
		} catch (error) {
			console.error("Discarding unusable teleprompter window:", error);
			await cleanupFailedWindow(existingWindow, openerWindow);
		}
	}

	if (creatingWindow) return;
	const platform = ostype();
	const isWindows = platform === "windows";
	const openerWindow = isWindows ? WebviewWindow.getCurrent() : undefined;

	const teleprompterWindow = new WebviewWindow(
		TELEPROMPTER_WINDOW_LABEL,
		getTeleprompterWindowOptions(
			platform,
			window.__CAP__?.windowsWebview2BrowserArgs,
		),
	);
	creatingWindow = teleprompterWindow;

	void teleprompterWindow.once("tauri://created", () => {
		if (!isWindows) {
			creatingWindow = undefined;
			void commands.refreshWindowContentProtection();
			return;
		}
		if (!openerWindow) return;

		void teleprompterWindow
			.innerPosition()
			.then(() => {
				if (creatingWindow === teleprompterWindow) creatingWindow = undefined;
			})
			.catch(async (error) => {
				console.error("Teleprompter window has no native handle:", error);
				await cleanupFailedWindow(teleprompterWindow, openerWindow);
			});
	});
	void teleprompterWindow.once("tauri://error", (event) => {
		console.error("Failed to create teleprompter window:", event.payload);
		if (isWindows && openerWindow) {
			void cleanupFailedWindow(teleprompterWindow, openerWindow);
		} else {
			creatingWindow = undefined;
		}
	});
}
