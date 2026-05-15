import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupportedMimeType } from "./mime-types";

const originalMediaRecorder = globalThis.MediaRecorder;

afterEach(() => {
	if (originalMediaRecorder) {
		globalThis.MediaRecorder = originalMediaRecorder;
	} else {
		delete (globalThis as { MediaRecorder?: typeof MediaRecorder })
			.MediaRecorder;
	}
});

const setSupportedMimeTypes = (mimeTypes: ReadonlyArray<string>) => {
	globalThis.MediaRecorder = {
		isTypeSupported: vi.fn((mimeType: string) => mimeTypes.includes(mimeType)),
	} as unknown as typeof MediaRecorder;
};

describe("getSupportedMimeType", () => {
	it("returns the first supported MIME type by preference order", () => {
		setSupportedMimeTypes(["video/webm;codecs=vp8,opus", "video/webm"]);

		expect(getSupportedMimeType()).toBe("video/webm;codecs=vp8,opus");
	});

	it("prefers vp9,opus over vp8,opus when both are supported", () => {
		setSupportedMimeTypes([
			"video/webm;codecs=vp9,opus",
			"video/webm;codecs=vp8,opus",
		]);

		expect(getSupportedMimeType()).toBe("video/webm;codecs=vp9,opus");
	});

	it("falls back to an empty string when no preferred types are supported", () => {
		setSupportedMimeTypes([]);

		expect(getSupportedMimeType()).toBe("");
	});
});
