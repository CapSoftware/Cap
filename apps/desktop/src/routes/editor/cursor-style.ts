import type { CursorType } from "~/utils/tauri";

export type CursorFamily = "macos" | "tahoe" | "windows";
export type CursorStyle = CursorFamily | "auto" | "circle";

export function selectedCursorStyle(type: CursorType): CursorStyle {
	return type === "pointer" ? "auto" : type;
}

export function cursorStyleOrder(platform: string): CursorStyle[] {
	return platform === "windows"
		? ["auto", "windows", "macos", "tahoe", "circle"]
		: ["auto", "macos", "tahoe", "windows", "circle"];
}

export function cursorStyleDescription(style: CursorStyle): string {
	switch (style) {
		case "auto":
			return "保留录制时的光标形状和外观。";
		case "macos":
			return "经典 macOS 外观。自定义光标会保持录制时的形状。";
		case "tahoe":
			return "macOS Tahoe 外观。自定义光标会保持录制时的形状。";
		case "windows":
			return "Windows 外观。自定义光标会保持录制时的形状。";
		case "circle":
			return "把所有光标形状替换为圆形。";
	}
}
