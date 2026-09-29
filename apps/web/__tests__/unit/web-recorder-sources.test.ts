import { describe, expect, it } from "vitest";
import {
	canRecordMicOnly,
	micOnlyFileExtension,
	micOnlyLanding,
	micOnlyMimeType,
	startRecordingChoice,
} from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/recording-sources";

const base = {
	screenShared: false,
	cameraEnabled: false,
	screenSupported: true,
	cameraOnlyPromptDismissed: false,
};

describe("startRecordingChoice", () => {
	it("records straight away once a screen is shared", () => {
		expect(
			startRecordingChoice({
				...base,
				screenShared: true,
				cameraEnabled: true,
			}),
		).toBe("record");
		expect(startRecordingChoice({ ...base, screenShared: true })).toBe(
			"record",
		);
	});

	it("opens the screen picker when nothing visual is on", () => {
		expect(startRecordingChoice(base)).toBe("share-then-record");
	});

	it("asks before recording just the camera", () => {
		expect(startRecordingChoice({ ...base, cameraEnabled: true })).toBe(
			"confirm-camera-only",
		);
	});

	it("skips the question once it's turned off", () => {
		expect(
			startRecordingChoice({
				...base,
				cameraEnabled: true,
				cameraOnlyPromptDismissed: true,
			}),
		).toBe("record");
	});

	it("never asks when the browser can't record a screen", () => {
		expect(
			startRecordingChoice({
				...base,
				cameraEnabled: true,
				screenSupported: false,
			}),
		).toBe("record");
	});
});

describe("canRecordMicOnly", () => {
	const idle = {
		screenShared: false,
		cameraEnabled: false,
		micEnabled: true,
		idle: true,
	};

	it("is offered with only a microphone on", () => {
		expect(canRecordMicOnly(idle)).toBe(true);
	});

	it("isn't offered with a screen, a camera, no mic, or mid-recording", () => {
		expect(canRecordMicOnly({ ...idle, screenShared: true })).toBe(false);
		expect(canRecordMicOnly({ ...idle, cameraEnabled: true })).toBe(false);
		expect(canRecordMicOnly({ ...idle, micEnabled: false })).toBe(false);
		expect(canRecordMicOnly({ ...idle, idle: false })).toBe(false);
	});
});

describe("microphone recording format", () => {
	it("prefers Opus in WebM and falls back to AAC in MP4", () => {
		expect(micOnlyMimeType(() => true)).toBe("audio/webm;codecs=opus");
		expect(micOnlyMimeType((type) => type.startsWith("audio/mp4"))).toBe(
			"audio/mp4;codecs=mp4a.40.2",
		);
		expect(micOnlyMimeType(() => false)).toBeUndefined();
		expect(
			micOnlyMimeType(() => {
				throw new Error("unsupported");
			}),
		).toBeUndefined();
	});

	it("names the file for its container", () => {
		expect(micOnlyFileExtension("audio/webm;codecs=opus")).toBe("webm");
		expect(micOnlyFileExtension("audio/mp4")).toBe("m4a");
		expect(micOnlyFileExtension("audio/ogg;codecs=opus")).toBe("ogg");
	});
});

describe("micOnlyLanding", () => {
	it("opens the editor for web editor users and the share page otherwise", () => {
		expect(micOnlyLanding("abc123", true)).toBe("/s/abc123/edit?from=import");
		expect(micOnlyLanding("abc123", false)).toBe("/s/abc123");
	});
});
