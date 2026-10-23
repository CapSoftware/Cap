import { describe, expect, it } from "vitest";

import {
	DEFAULT_TRANSCRIPTION_HINTS,
	deriveGeneralSettings,
	formatTranscriptionHints,
	normalizeTranscriptionHints,
	parseTranscriptionHints,
	RECORDING_START_SAFETY_DEFAULTS,
	shouldConfirmRecordingWithoutMicrophone,
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

	it("enables microphone confirmation by default", () => {
		expect(
			RECORDING_START_SAFETY_DEFAULTS.confirmBeforeRecordingWithoutMicrophone,
		).toBe(true);
	});

	it.each([
		{
			mode: "studio" as const,
			enabled: true,
			microphone: null,
			expected: true,
		},
		{
			mode: "instant" as const,
			enabled: true,
			microphone: null,
			expected: true,
		},
		{
			mode: "studio" as const,
			enabled: true,
			microphone: "MacBook Microphone",
			expected: false,
		},
		{
			mode: "instant" as const,
			enabled: false,
			microphone: null,
			expected: false,
		},
		{
			mode: "screenshot" as const,
			enabled: true,
			microphone: null,
			expected: false,
		},
	])(
		"returns $expected for $mode with enabled=$enabled and microphone=$microphone",
		({ mode, enabled, microphone, expected }) => {
			expect(
				shouldConfirmRecordingWithoutMicrophone(mode, enabled, microphone),
			).toBe(expected);
		},
	);
});
