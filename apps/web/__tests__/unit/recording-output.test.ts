import {
	getPublishedRecordingCopyKeys,
	getPublishedRecordingOutputKey,
	isInternalRecordingKey,
	resolveRecordingObjectKey,
} from "@cap/web-backend/src/Storage/recording-output";
import { Video } from "@cap/web-domain";
import { describe, expect, it } from "vitest";

const prefix = "owner/video/";
const outputKey = `${prefix}.recording/outputs/generation/attempt.mp4`;
const thumbnailKey = `${prefix}.recording/outputs/generation/attempt/screenshot.jpg`;
const previewKey = `${prefix}.recording/outputs/generation/attempt/preview.gif`;
const video = {
	id: "video",
	ownerId: "owner",
	source: { type: "desktopMP4", outputKey, thumbnailKey, previewKey },
};

describe("published recording storage keys", () => {
	it("duplicates the verified output and current assets using new canonical keys", () => {
		expect(getPublishedRecordingCopyKeys(video)).toEqual([
			`${prefix}result.mp4`,
			`${prefix}screenshot/screen-capture.jpg`,
			`${prefix}preview/animated-preview.gif`,
		]);
		expect(
			getPublishedRecordingCopyKeys({
				...video,
				source: { type: "desktopMP4" },
			}),
		).toEqual([]);
	});
	it("resolves legacy playback, download, and media keys to one committed attempt", () => {
		expect(
			new Video.Mp4Source({
				ownerId: video.ownerId,
				videoId: video.id,
				outputKey,
			}).getFileKey(),
		).toBe(outputKey);
		expect(resolveRecordingObjectKey(video, `${prefix}result.mp4`)).toBe(
			outputKey,
		);
		expect(
			resolveRecordingObjectKey(
				video,
				`${prefix}screenshot/screen-capture.jpg`,
			),
		).toBe(thumbnailKey);
		expect(
			resolveRecordingObjectKey(video, `${prefix}preview/animated-preview.gif`),
		).toBe(previewKey);
	});

	it("serves a retained MP4 snapshot without overwriting the uploaded original", () => {
		const snapshot = `${prefix}.recording/sources/generation/snapshot/mp4/0.mp4`;
		expect(
			getPublishedRecordingOutputKey({
				...video,
				source: { type: "desktopMP4", outputKey: snapshot },
			}),
		).toBe(snapshot);
	});

	it.each([
		"owner/other/.recording/outputs/generation/attempt.mp4",
		"other/video/.recording/outputs/generation/attempt.mp4",
		"owner/video/.recording/../result.mp4",
		"owner/video/.recording/outputs/attempt.mp4?token=secret",
		"owner/video/result.mp4",
		"owner/video/.recording/outputs/attempt.json",
	])("rejects an invalid committed output pointer %s", (key) => {
		const invalid = { ...video, source: { ...video.source, outputKey: key } };
		expect(
			new Video.Mp4Source({
				ownerId: video.ownerId,
				videoId: video.id,
				outputKey: key,
			}).getFileKey(),
		).toBe(`${prefix}result.mp4`);
		expect(getPublishedRecordingOutputKey(invalid)).toBeUndefined();
		expect(resolveRecordingObjectKey(invalid, `${prefix}result.mp4`)).toBe(
			`${prefix}result.mp4`,
		);
	});

	it("does not redirect other videos or raw recording fragments", () => {
		for (const key of [
			"owner/other/result.mp4",
			`${prefix}segments/manifest.json`,
			`${prefix}video/1.m4s`,
			outputKey,
		]) {
			expect(resolveRecordingObjectKey(video, key)).toBe(key);
		}
	});

	it("does not redirect legacy or intentionally replaced recordings", () => {
		for (const source of [
			{ type: "desktopMP4" },
			{ type: "desktopSegments", outputKey },
		]) {
			expect(
				resolveRecordingObjectKey({ ...video, source }, `${prefix}result.mp4`),
			).toBe(`${prefix}result.mp4`);
		}
	});

	it.each([
		"other/video/.recording/outputs/attempt/screenshot.jpg",
		`${prefix}.recording/sources/snapshot/video/0.mp4`,
		`${prefix}.recording/outputs/../screenshot.jpg`,
	])("does not alias an invalid thumbnail pointer %s", (key) => {
		expect(
			resolveRecordingObjectKey(
				{ ...video, source: { ...video.source, thumbnailKey: key } },
				`${prefix}screenshot/screen-capture.jpg`,
			),
		).toBe(`${prefix}screenshot/screen-capture.jpg`);
	});

	it("reserves both retained sources and uncommitted attempt outputs", () => {
		expect(isInternalRecordingKey(outputKey)).toBe(true);
		expect(
			isInternalRecordingKey(
				`${prefix}.recording/sources/generation/inventory.json`,
			),
		).toBe(true);
		expect(isInternalRecordingKey(`${prefix}result.mp4`)).toBe(false);
		expect(isInternalRecordingKey(`${prefix}.recording-copy/result.mp4`)).toBe(
			false,
		);
	});
});
