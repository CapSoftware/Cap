import { describe, expect, it } from "vitest";
import {
	getAudioRecorderUploadKind,
	getMultipartFileKey,
	getSubpath,
	isCameraRecorderUpload,
	isDisplayRecorderUpload,
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

	it("accepts only canonical paired recording media paths", () => {
		for (const extension of ["webm", "mp4"]) {
			expect(isDisplayRecorderUpload(`raw-upload.${extension}`)).toBe(true);
			expect(isCameraRecorderUpload(`camera-upload.${extension}`)).toBe(true);
		}
		for (const subpath of [
			"camera-upload.webm/extra",
			"camera-upload.webm.bak",
			"raw-upload.webm/extra",
			"../camera-upload.webm",
			"result.mp4",
		]) {
			expect(isDisplayRecorderUpload(subpath)).toBe(false);
			expect(isCameraRecorderUpload(subpath)).toBe(false);
		}
	});

	it("accepts only canonical microphone and system-audio sidecar paths", () => {
		for (const extension of ["webm", "mp4"]) {
			expect(getAudioRecorderUploadKind(`mic-upload.${extension}`)).toBe("mic");
			expect(
				getAudioRecorderUploadKind(`system-audio-upload.${extension}`),
			).toBe("systemAudio");
		}
		for (const subpath of [
			"../mic-upload.webm",
			"mic-upload.webm/extra",
			"mic-upload.webm.bak",
			"system-audio-upload.wav",
			"system-audio-upload.webm/extra",
			"audio-upload.webm",
		]) {
			expect(getAudioRecorderUploadKind(subpath)).toBeNull();
		}
	});

	it("rejects missing video ids", () => {
		expect(() =>
			getMultipartFileKey("user-123", {
				subpath: "raw-upload.webm",
			}),
		).toThrow("Video id not found");
	});

	it("rejects writes into retained sources and immutable outputs", () => {
		for (const subpath of [
			".recording/sources/generation/snapshot/video/0.mp4",
			".recording/outputs/generation/attempt.mp4",
		]) {
			expect(() =>
				getMultipartFileKey("owner", { videoId: "video", subpath }),
			).toThrow("Recording snapshots are immutable");
			expect(() =>
				getMultipartFileKey("owner", { fileKey: `owner/video/${subpath}` }),
			).toThrow("Recording snapshots are immutable");
		}
	});
});
