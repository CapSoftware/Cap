import { describe, expect, it, vi } from "vitest";

import { getSupportedMimeType } from "./mime-types";

describe("sdk-recorder mime type selection", () => {
	it("prioritizes higher quality preferred codecs first", () => {
		const isTypeSupported = vi.fn((mimeType: string) =>
			[
				"video/webm;codecs=vp9,opus",
				"video/webm;codecs=vp8,opus",
				"video/webm",
			].includes(mimeType),
		);
		vi.stubGlobal("MediaRecorder", { isTypeSupported });

		expect(getSupportedMimeType()).toBe("video/webm;codecs=vp9,opus");
		expect(isTypeSupported).toHaveBeenCalledTimes(1);
		expect(isTypeSupported).toHaveBeenCalledWith("video/webm;codecs=vp9,opus");

		vi.unstubAllGlobals();
	});

	it("returns empty string when no preferred mime type is supported", () => {
		vi.stubGlobal("MediaRecorder", { isTypeSupported: vi.fn(() => false) });

		expect(getSupportedMimeType()).toBe("");

		vi.unstubAllGlobals();
	});
});
