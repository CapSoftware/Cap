import type { VideoMetadata } from "@cap/database/types";
import { describe, expect, it } from "vitest";
import {
	createEditorVideoLocation,
	editorVideoExtension,
	editorVideoUploadMatches,
	validateEditorVideoParts,
	validEditorVideoAsset,
} from "../lib/editor-video-upload";

const ownerId = "owner";
const videoId = "video";

describe("editor video upload boundaries", () => {
	it("accepts supported videos with a visible basename and matching MIME type", () => {
		expect(editorVideoExtension("demo.MP4", 100, "video/mp4")).toBe("mp4");
		expect(editorVideoExtension(".mp4", 100, "video/mp4")).toBeNull();
		expect(editorVideoExtension(" .mp4", 100, "video/mp4")).toBeNull();
		expect(
			editorVideoExtension("folder/demo.mp4", 100, "video/mp4"),
		).toBeNull();
		expect(editorVideoExtension("demo.mp4", 100, "video/webm")).toBeNull();
	});

	it("binds saved assets and pending uploads to the recording and storage provider", () => {
		const location = createEditorVideoLocation(ownerId, videoId, "mov");
		const asset = {
			...location,
			name: "demo",
			contentType: "video/quicktime",
			size: 100,
			objectIdentity: "etag",
		};
		expect(validEditorVideoAsset(asset, ownerId, videoId)).toBe(true);
		expect(validEditorVideoAsset(asset, "other", videoId)).toBe(false);
		const pending: NonNullable<VideoMetadata["webEditorVideoUpload"]> = {
			version: 1,
			sessionId: "session",
			...location,
			fileName: "demo.mov",
			size: 100,
			contentType: "video/quicktime",
			uploadId: "upload",
			provider: "s3",
			bucketId: "bucket",
			storageIntegrationId: null,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		};
		const binding = {
			ownerId,
			videoId,
			sessionId: pending.sessionId,
			uploadId: pending.uploadId,
			key: pending.key,
			path: pending.path,
			bucketId: pending.bucketId,
			storageIntegrationId: pending.storageIntegrationId,
		};
		expect(editorVideoUploadMatches(pending, binding)).toBe(true);
		expect(
			editorVideoUploadMatches(pending, { ...binding, bucketId: "other" }),
		).toBe(false);
		expect(
			editorVideoUploadMatches(pending, { ...binding, sessionId: "other" }),
		).toBe(false);
		expect(
			editorVideoUploadMatches(
				{ ...pending, expiresAt: "2000-01-01" },
				binding,
			),
		).toBe(false);
	});

	it("requires complete, sequential multipart bytes with S3-sized intermediate parts", () => {
		const minimum = 5 * 1024 * 1024;
		const first = { partNumber: 1, etag: "first", size: minimum };
		const last = { partNumber: 2, etag: "second", size: 1 };
		const parts = [first, last];
		expect(validateEditorVideoParts(parts, minimum + 1)).toBe(true);
		expect(
			validateEditorVideoParts(
				[{ ...first, size: minimum - 1 }, last],
				minimum,
			),
		).toBe(false);
		expect(
			validateEditorVideoParts(
				[first, { ...last, partNumber: 3 }],
				minimum + 1,
			),
		).toBe(false);
		expect(validateEditorVideoParts(parts, minimum + 2)).toBe(false);
	});
});
