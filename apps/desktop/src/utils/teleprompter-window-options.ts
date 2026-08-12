import { LogicalPosition } from "~/electron/dpi";
import type { WebviewWindow } from "~/electron/webviewWindow";
import type { OsType } from "~/electron/os";

export type TeleprompterWindowOptions = NonNullable<
	ConstructorParameters<typeof WebviewWindow>[1]
> & {
	additionalBrowserArgs?: string;
};

export function getTeleprompterWindowOptions(
	platform: OsType,
	windowsWebview2BrowserArgs?: string,
): TeleprompterWindowOptions {
	const isMacOS = platform === "macos";
	const isWindows = platform === "windows";
	if (isWindows && !windowsWebview2BrowserArgs) {
		throw new Error("Missing Windows WebView2 browser arguments");
	}

	return {
		url: "/teleprompter",
		title: "Cap Teleprompter",
		width: 560,
		height: 320,
		minWidth: 420,
		minHeight: 220,
		center: true,
		focus: !isWindows,
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
		additionalBrowserArgs: isWindows ? windowsWebview2BrowserArgs : undefined,
	};
}
