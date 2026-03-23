import { describe, expect, it } from "vitest";
import {
	getMultipartFileKey,
	getSubpath,
	isRawRecorderUpload,
} from "@/app/api/upload/[...route]/multipart-utils";

describe("multipart upload utils", () => {
	it("builds a multipart file key from video id and subpath", () => {
		expect(
			getMultipartFileKey("user-123", {
				videoId: "video-456",
				subpath: "raw-upload.webm",
			}),
		).toBe("user-123/video-456/raw-upload.webm");
	});

	it("defaults the multipart subpath to result.mp4", () => {
		const input: { subpath?: string } = {};

		expect(
			getMultipartFileKey("user-123", {
				videoId: "video-456",
			}),
		).toBe("user-123/video-456/result.mp4");
		expect(getSubpath(input)).toBe("result.mp4");
	});

	it("parses deprecated fileKey input into the current user-scoped key", () => {
		expect(
			getMultipartFileKey("user-123", {
				fileKey: "legacy-owner/video-456/raw-upload.webm",
			}),
		).toBe("user-123/video-456/raw-upload.webm");
		expect(
			getSubpath({
				fileKey: "legacy-owner/video-456/raw-upload.webm",
			}),
		).toBeUndefined();
	});

	it("detects raw recorder uploads", () => {
		expect(isRawRecorderUpload("raw-upload.webm")).toBe(true);
		expect(isRawRecorderUpload("raw-upload.mp4")).toBe(true);
		expect(isRawRecorderUpload("result.mp4")).toBe(false);
	});

	it("rejects missing video ids", () => {
		expect(() =>
			getMultipartFileKey("user-123", {
				subpath: "raw-upload.webm",
			}),
		).toThrow("Video id not found");
	});
});
