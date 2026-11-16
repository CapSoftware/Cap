import { describe, expect, it } from "vitest";
import {
	CUSTOM_THUMBNAIL_MAX_DIMENSION,
	clampThumbnailFrameTime,
	fitThumbnailSize,
	isJpegData,
	validateThumbnailSourceFile,
} from "@/lib/custom-thumbnail";
import {
	buildShareVideoMetadata,
	getShareVideoUrls,
} from "@/lib/share-video-metadata";
import {
	customThumbnailKey,
	getCustomThumbnailKey,
	getCustomThumbnailMetadata,
	getCustomThumbnailVersion,
	isCustomThumbnailFileName,
} from "../../../../packages/web-backend/src/Storage/custom-thumbnail";

const video = { id: "vid123", ownerId: "owner456" };

describe("custom thumbnail metadata", () => {
	it("resolves a key under the video's own prefix", () => {
		const metadata = {
			customThumbnail: {
				file: "custom-lz9k2a1b2c3.jpg",
				source: "frame",
				time: 12.5,
				updatedAt: "2026-11-16T10:00:00.000Z",
			},
		};
		expect(getCustomThumbnailKey({ ...video, metadata })).toBe(
			"owner456/vid123/thumbnail/custom-lz9k2a1b2c3.jpg",
		);
		expect(getCustomThumbnailMetadata(metadata)).toEqual(
			metadata.customThumbnail,
		);
		expect(getCustomThumbnailVersion(metadata)).toBe("lz9k2a1b2c3");
	});

	it("ignores old videos and anything that is not a plain file name", () => {
		for (const metadata of [
			null,
			undefined,
			{},
			{ customThumbnail: null },
			{ customThumbnail: { file: "../other/screenshot.jpg" } },
			{ customThumbnail: { file: "custom-abc.png" } },
			{ customThumbnail: { file: "custom-ABC.jpg" } },
			{ customThumbnail: { file: "custom-a/b.jpg" } },
			{ customThumbnail: { file: "custom-.jpg" } },
			{ customThumbnail: { file: 42 } },
		]) {
			expect(getCustomThumbnailKey({ ...video, metadata })).toBeUndefined();
			expect(getCustomThumbnailVersion(metadata)).toBeNull();
		}
	});

	it("defaults the source and drops a bad time", () => {
		expect(
			getCustomThumbnailMetadata({
				customThumbnail: { file: "custom-a1.jpg", source: "x", time: "1" },
			}),
		).toEqual({ file: "custom-a1.jpg", source: "upload", updatedAt: "" });
	});

	it("follows the video when it is duplicated under a new id", () => {
		const metadata = { customThumbnail: { file: "custom-a1.jpg" } };
		expect(
			getCustomThumbnailKey({ id: "copy789", ownerId: "owner456", metadata }),
		).toBe(
			customThumbnailKey({
				id: "copy789",
				ownerId: "owner456",
				file: "custom-a1.jpg",
			}),
		);
	});

	it("validates file names", () => {
		expect(isCustomThumbnailFileName("custom-0a.jpg")).toBe(true);
		expect(isCustomThumbnailFileName(`custom-${"a".repeat(33)}.jpg`)).toBe(
			false,
		);
	});
});

describe("thumbnail input checks", () => {
	it("accepts PNG, JPEG and WebP sources up to 20 MB", () => {
		expect(
			validateThumbnailSourceFile({ type: "image/png", size: 1024 }),
		).toBeNull();
		expect(
			validateThumbnailSourceFile({ type: "IMAGE/JPEG", size: 1024 }),
		).toBeNull();
		expect(
			validateThumbnailSourceFile({ type: "image/webp", size: 1024 }),
		).toBeNull();
		expect(
			validateThumbnailSourceFile({ type: "image/svg+xml", size: 10 }),
		).not.toBeNull();
		expect(
			validateThumbnailSourceFile({ type: "image/gif", size: 10 }),
		).not.toBeNull();
		expect(
			validateThumbnailSourceFile({ type: "image/png", size: 0 }),
		).not.toBeNull();
		expect(
			validateThumbnailSourceFile({
				type: "image/png",
				size: 20 * 1024 * 1024 + 1,
			}),
		).not.toBeNull();
	});

	it("recognises complete JPEG data only", () => {
		expect(
			isJpegData(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9])),
		).toBe(true);
		expect(
			isJpegData(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])),
		).toBe(false);
		expect(
			isJpegData(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00])),
		).toBe(false);
		expect(isJpegData(new Uint8Array([0xff, 0xd8]))).toBe(false);
	});

	it("fits inside the bounds without upscaling", () => {
		expect(fitThumbnailSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
		expect(fitThumbnailSize(1080, 2400)).toEqual({
			width: 864,
			height: CUSTOM_THUMBNAIL_MAX_DIMENSION,
		});
		expect(fitThumbnailSize(1280, 720)).toEqual({ width: 1280, height: 720 });
		expect(fitThumbnailSize(0, 720)).toBeNull();
	});

	it("clamps frame times inside the video", () => {
		expect(clampThumbnailFrameTime(12.3456, 60)).toBe(12.346);
		expect(clampThumbnailFrameTime(100, 60)).toBeCloseTo(59.95, 5);
		expect(clampThumbnailFrameTime(5, null)).toBe(5);
		expect(clampThumbnailFrameTime(0, 0)).toBe(0);
		for (const time of [-1, Number.NaN, Number.POSITIVE_INFINITY, "3", null]) {
			expect(clampThumbnailFrameTime(time, 60)).toBeNull();
		}
	});
});

describe("link previews with a custom thumbnail", () => {
	const base = {
		videoId: "vid123",
		name: "Demo",
		sourceType: "desktopMP4" as const,
		webUrl: "https://cap.so",
		width: 1920,
		height: 1080,
	};

	it("versions the preview image and drops the animated preview", () => {
		const metadata = buildShareVideoMetadata({
			...base,
			thumbnailVersion: "lz9k2a",
		});
		expect(metadata.openGraph?.images).toEqual([
			{
				url: "https://cap.so/api/video/og?videoId=vid123&v=lz9k2a",
				width: 1200,
				height: 630,
				type: "image/png",
			},
		]);
		expect(metadata.twitter?.images).toEqual([
			"https://cap.so/api/video/og?videoId=vid123&v=lz9k2a",
		]);
	});

	it("leaves previews unchanged for videos without one", () => {
		expect(buildShareVideoMetadata(base)).toEqual(
			buildShareVideoMetadata({ ...base, thumbnailVersion: null }),
		);
		expect(getShareVideoUrls(base).ogImageUrl).toBe(
			"https://cap.so/api/video/og?videoId=vid123",
		);
		const images = buildShareVideoMetadata(base).openGraph?.images;
		expect(Array.isArray(images) ? images.length : 0).toBe(2);
	});
});
