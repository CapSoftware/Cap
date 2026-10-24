import { describe, expect, it } from "vitest";
import { getPostResizeWindowPosition } from "./window-geometry";

const builtInDisplayWorkArea = {
	position: { x: 0, y: 0 },
	size: { width: 1352, height: 848 },
};

describe("main window geometry", () => {
	it("restores the top edge after a macOS resize moves it above the display", () => {
		expect(
			getPostResizeWindowPosition(
				{ x: 376, y: 100 },
				{ x: 376, y: -165 },
				{ width: 600, height: 660 },
				builtInDisplayWorkArea,
				12,
			),
		).toEqual({ x: 376, y: 100 });
	});

	it("keeps the resized window inside a display with a negative origin", () => {
		expect(
			getPostResizeWindowPosition(
				{ x: 1700, y: -400 },
				{ x: 1700, y: -400 },
				{ width: 600, height: 660 },
				{
					position: { x: 1352, y: -274 },
					size: { width: 2048, height: 1152 },
				},
				12,
			),
		).toEqual({ x: 1700, y: -262 });
	});

	it("does not move a window that stayed at its intended position", () => {
		expect(
			getPostResizeWindowPosition(
				{ x: 376, y: 100 },
				{ x: 376, y: 100 },
				{ width: 600, height: 660 },
				builtInDisplayWorkArea,
				12,
			),
		).toBeNull();
	});
});
