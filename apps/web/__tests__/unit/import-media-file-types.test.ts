import { describe, expect, it } from "vitest";
import {
	getSupportedImageContentType,
	isSupportedMediaFile,
	isSupportedVideoFile,
} from "@/app/(org)/dashboard/import/media-file-types";

const file = (name: string, type = "") => ({ name, type });

describe("dashboard media import file matching", () => {
	it("accepts videos from MIME type or filename extension", () => {
		expect(isSupportedVideoFile(file("", "video/mp4"))).toBe(true);
		expect(isSupportedVideoFile(file("clip.MOV"))).toBe(true);
		expect(isSupportedVideoFile(file("clip.webm"))).toBe(true);
	});

	it("accepts JPEG and PNG images from MIME type or filename extension", () => {
		expect(getSupportedImageContentType(file("", "image/png"))).toBe(
			"image/png",
		);
		expect(getSupportedImageContentType(file("image.JPG"))).toBe("image/jpeg");
		expect(getSupportedImageContentType(file("image.jpeg"))).toBe("image/jpeg");
	});

	it("rejects unsupported clipboard files", () => {
		expect(isSupportedMediaFile(file("notes.txt", "text/plain"))).toBe(false);
		expect(isSupportedMediaFile(file("image.gif", "image/gif"))).toBe(false);
		expect(isSupportedMediaFile(file("archive.zip"))).toBe(false);
	});
});
