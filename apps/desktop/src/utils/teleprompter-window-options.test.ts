import { describe, expect, it } from "vitest";
import { getTeleprompterWindowOptions } from "./teleprompter-window-options";

describe("getTeleprompterWindowOptions", () => {
	it("keeps a Windows window unfocused and reuses the process browser arguments", () => {
		const browserArgs = "--disable-vulkan --use-angle=d3d11 --disable-gpu";

		expect(getTeleprompterWindowOptions("windows", browserArgs)).toMatchObject({
			focus: false,
			visible: false,
			decorations: false,
			additionalBrowserArgs: browserArgs,
		});
	});

	it("preserves the macOS window behavior without Windows browser arguments", () => {
		expect(
			getTeleprompterWindowOptions("macos", "--disable-gpu"),
		).toMatchObject({
			focus: true,
			visible: false,
			decorations: true,
			additionalBrowserArgs: undefined,
		});
	});

	it("refuses to create a Windows window without the process browser arguments", () => {
		expect(() => getTeleprompterWindowOptions("windows")).toThrow(
			"Missing Windows WebView2 browser arguments",
		);
	});
});
