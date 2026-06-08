import { describe, expect, it } from "vitest";

import {
	DEFAULT_TRANSCRIPTION_HINTS,
	deriveGeneralSettings,
	formatTranscriptionHints,
	normalizeTranscriptionHints,
	parseTranscriptionHints,
} from "~/utils/general-settings";

describe("general-settings", () => {
	it("normalizes transcription hints from text input", () => {
		expect(
			parseTranscriptionHints(" Cap \n\nTypeScript\nCap\nGitHub\n"),
		).toEqual(["Cap", "TypeScript", "GitHub"]);
	});

	it("formats transcription hints for the textarea", () => {
		expect(formatTranscriptionHints(["Cap", "TypeScript", "Cap"])).toBe(
			"Cap\nTypeScript",
		);
	});

	it("normalizes transcription hints from a list", () => {
		expect(
			normalizeTranscriptionHints([" Cap ", "", "TypeScript", "Cap", "GitHub"]),
		).toEqual(["Cap", "TypeScript", "GitHub"]);
	});

	it("defaults transcription hints when missing", () => {
		expect(deriveGeneralSettings(null).transcriptionHints).toEqual(
			DEFAULT_TRANSCRIPTION_HINTS,
		);
	});

	it("defaults recording enhancements when fields are missing", () => {
		expect(
			deriveGeneralSettings({
				enableNativeCameraPreview: false,
			}),
		).toMatchObject({
			autoZoomOnClicks: false,
			captureKeyboardEvents: true,
			custom_cursor_capture2: true,
			postScreenshotCaptureBehaviour: "openEditor",
			screenshotSaveDestination: "desktop",
			screenshotSaveDirectory: null,
		});
	});

	it("normalizes legacy screenshot save actions into save destinations", () => {
		expect(
			deriveGeneralSettings({
				enableNativeCameraPreview: false,
				postScreenshotCaptureBehaviour: "save",
			}),
		).toMatchObject({
			postScreenshotCaptureBehaviour: "doNothing",
			screenshotSaveDestination: "desktop",
		});

		expect(
			deriveGeneralSettings({
				enableNativeCameraPreview: false,
				postScreenshotCaptureBehaviour: "saveToFolder",
			}),
		).toMatchObject({
			postScreenshotCaptureBehaviour: "doNothing",
			screenshotSaveDestination: "chosenFolder",
		});
	});

	it("preserves explicit disabled recording enhancements", () => {
		expect(
			deriveGeneralSettings({
				enableNativeCameraPreview: false,
				autoZoomOnClicks: false,
				captureKeyboardEvents: false,
				custom_cursor_capture2: false,
			}),
		).toMatchObject({
			autoZoomOnClicks: false,
			captureKeyboardEvents: false,
			custom_cursor_capture2: false,
		});
	});
});
