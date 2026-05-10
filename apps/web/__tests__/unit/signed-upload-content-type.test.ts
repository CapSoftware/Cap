import { describe, expect, it } from "vitest";
import { contentTypeForSubpath } from "@/lib/upload-content-type";

describe("signed upload content types", () => {
	it("uses video content types for browser studio video sources", () => {
		expect(contentTypeForSubpath("studio/assets/screen.webm")).toBe(
			"video/webm",
		);
		expect(contentTypeForSubpath("studio/assets/camera.mp4")).toBe("video/mp4");
	});

	it("uses audio content types for separate audio sources", () => {
		expect(contentTypeForSubpath("studio/assets/microphone.m4a")).toBe(
			"audio/mp4",
		);
		expect(contentTypeForSubpath("studio/assets/system.aac")).toBe("audio/aac");
	});
});
