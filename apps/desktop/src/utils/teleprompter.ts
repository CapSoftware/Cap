import { LogicalPosition } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type as ostype } from "@tauri-apps/plugin-os";
import { commands } from "./tauri";

export const TELEPROMPTER_WINDOW_LABEL = "teleprompter";

let creatingWindow: WebviewWindow | undefined;

export async function openTeleprompter() {
	const existingWindow = await WebviewWindow.getByLabel(
		TELEPROMPTER_WINDOW_LABEL,
	);

	if (existingWindow) {
		await commands.refreshWindowContentProtection();
		await existingWindow.unminimize();
		await existingWindow.show();
		await existingWindow.setFocus();
		return;
	}

	if (creatingWindow) return;
	const isMacOS = ostype() === "macos";

	const teleprompterWindow = new WebviewWindow(TELEPROMPTER_WINDOW_LABEL, {
		url: "/teleprompter",
		title: "Cap Teleprompter",
		width: 560,
		height: 320,
		minWidth: 420,
		minHeight: 220,
		center: true,
		focus: true,
		visible: false,
		resizable: true,
		decorations: isMacOS,
		titleBarStyle: isMacOS ? "overlay" : undefined,
		hiddenTitle: isMacOS,
		trafficLightPosition: isMacOS ? new LogicalPosition(14, 14) : undefined,
		transparent: true,
		shadow: true,
		alwaysOnTop: true,
		visibleOnAllWorkspaces: true,
		skipTaskbar: true,
	});
	creatingWindow = teleprompterWindow;

	void teleprompterWindow.once("tauri://created", () => {
		creatingWindow = undefined;
		void commands.refreshWindowContentProtection();
	});
	void teleprompterWindow.once("tauri://error", (event) => {
		creatingWindow = undefined;
		console.error("Failed to create teleprompter window:", event.payload);
	});
}
