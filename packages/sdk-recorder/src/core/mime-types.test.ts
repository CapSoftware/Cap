import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupportedMimeType } from "./mime-types";

describe("getSupportedMimeType", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns the first supported preferred MIME type", () => {
		vi.stubGlobal("MediaRecorder", {
			isTypeSupported: (mimeType: string) =>
				mimeType === "video/webm;codecs=vp8,opus",
		});

		expect(getSupportedMimeType()).toBe("video/webm;codecs=vp8,opus");
	});

	it("returns an empty string when the browser supports none of the preferred types", () => {
		vi.stubGlobal("MediaRecorder", {
			isTypeSupported: () => false,
		});

		expect(getSupportedMimeType()).toBe("");
	});
});
