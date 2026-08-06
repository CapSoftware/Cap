import { findScreenshotObjectKey } from "@cap/web-backend";
import { describe, expect, it } from "vitest";

describe("findScreenshotObjectKey", () => {
	it("prefers the canonical png screenshot key when object times match", () => {
		expect(
			findScreenshotObjectKey([
				{ Key: "user/video/screenshot/screen-capture.png" },
				{ Key: "user/video/screenshot/screen-capture.jpg" },
			]),
		).toBe("user/video/screenshot/screen-capture.png");
	});

	it("uses the newest screenshot when the rendered format changes", () => {
		expect(
			findScreenshotObjectKey([
				{
					Key: "user/video/screenshot/screen-capture.jpg",
					LastModified: new Date("2026-06-30T10:00:00Z"),
				},
				{
					Key: "user/video/screenshot/screen-capture.png",
					LastModified: new Date("2026-06-30T11:00:00Z"),
				},
			]),
		).toBe("user/video/screenshot/screen-capture.png");
	});

	it("uses png when the screenshot needs transparency", () => {
		expect(
			findScreenshotObjectKey([
				{ Key: "user/video/result.mp4" },
				{ Key: "user/video/screenshot/screen-capture.png" },
			]),
		).toBe("user/video/screenshot/screen-capture.png");
	});

	it("falls back to legacy screenshot keys", () => {
		expect(
			findScreenshotObjectKey([
				{ Key: "user/video/display.jpg" },
				{ Key: "user/video/screen-capture.jpg" },
			]),
		).toBe("user/video/screen-capture.jpg");
	});

	it("prefers canonical screenshot keys over legacy keys", () => {
		expect(
			findScreenshotObjectKey([
				{ Key: "user/video/screen-capture.jpg" },
				{ Key: "user/video/screenshot/screen-capture.jpg" },
			]),
		).toBe("user/video/screenshot/screen-capture.jpg");
	});

	it("ignores unrelated image names", () => {
		expect(
			findScreenshotObjectKey([
				{ Key: "user/video/display.jpg" },
				{ Key: "user/video/screenshot/other.jpg" },
			]),
		).toBeNull();
	});
});
