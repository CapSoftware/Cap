import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupportedMimeType } from "./mime-types";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("getSupportedMimeType", () => {
	it("selects the first supported MIME type by priority", () => {
		vi.stubGlobal("MediaRecorder", {
			isTypeSupported: vi.fn((mimeType: string) => mimeType.includes("vp8")),
		});

		expect(getSupportedMimeType()).toBe("video/webm;codecs=vp8,opus");
	});

	it("returns an empty string when no preferred type is supported", () => {
		vi.stubGlobal("MediaRecorder", {
			isTypeSupported: vi.fn(() => false),
		});

		expect(getSupportedMimeType()).toBe("");
	});
});
