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
			return "Keeps the cursor shapes and appearance from your recording.";
		case "macos":
			return "Classic macOS appearance. Custom cursors keep their recorded shape.";
		case "tahoe":
			return "macOS Tahoe appearance. Custom cursors keep their recorded shape.";
		case "windows":
			return "Windows appearance. Custom cursors keep their recorded shape.";
		case "circle":
			return "Replaces all cursor shapes with a circle.";
	}
}
