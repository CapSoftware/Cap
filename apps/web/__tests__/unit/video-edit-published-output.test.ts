import {
	getPublishedRecordingCopyKeys,
	getPublishedRecordingOutputKey,
	resolveRecordingObjectKey,
} from "@cap/web-backend/src/Storage/recording-output";
import { describe, expect, it } from "vitest";

const prefix = "owner/video/";
const editPrefix = `${prefix}.recording/outputs/edit-11111111-1111-4111-8111-111111111111/`;

describe.each(["desktopMP4", "webMP4"])("published %s edit output", (type) => {
	const video = {
		id: "video",
		ownerId: "owner",
		source: {
			type,
			outputKey: `${editPrefix}result.mp4`,
			thumbnailKey: `${editPrefix}thumbnail.jpg`,
			previewKey: `${editPrefix}preview.gif`,
		},
	};
	it("resolves playback, thumbnails, previews and duplication to the current edit", () => {
		expect(getPublishedRecordingOutputKey(video)).toBe(
			`${editPrefix}result.mp4`,
		);
		expect(resolveRecordingObjectKey(video, `${prefix}result.mp4`)).toBe(
			`${editPrefix}result.mp4`,
		);
		expect(
			resolveRecordingObjectKey(
				video,
				`${prefix}screenshot/screen-capture.jpg`,
			),
		).toBe(`${editPrefix}thumbnail.jpg`);
		expect(
			resolveRecordingObjectKey(video, `${prefix}preview/animated-preview.gif`),
		).toBe(`${editPrefix}preview.gif`);
		expect(getPublishedRecordingCopyKeys(video)).toEqual([
			`${prefix}result.mp4`,
			`${prefix}screenshot/screen-capture.jpg`,
			`${prefix}preview/animated-preview.gif`,
		]);
	});
	it("ignores an audio derivative from before the current edit", () => {
		const stale = {
			...video,
			source: {
				...video.source,
				audioLevelSourceKey:
					type === "webMP4"
						? `${prefix}result.mp4`
						: `${prefix}.recording/outputs/generation/attempt.mp4`,
				audioLevelOutputKey: `${prefix}.recording/outputs/audio-quality-v3/old.mp4`,
			},
		};
		expect(resolveRecordingObjectKey(stale, `${prefix}result.mp4`)).toBe(
			`${editPrefix}result.mp4`,
		);
	});
	it("preserves original source reads", () => {
		const original = `${prefix}source/original.mp4`;
		expect(resolveRecordingObjectKey(video, original)).toBe(original);
	});
	it("rejects another recording's output and asset pointers", () => {
		const foreign = {
			...video,
			source: {
				type,
				outputKey: "other/video/.recording/outputs/x/result.mp4",
				thumbnailKey: "other/video/.recording/outputs/x/thumbnail.jpg",
			},
		};
		expect(resolveRecordingObjectKey(foreign, `${prefix}result.mp4`)).toBe(
			`${prefix}result.mp4`,
		);
		expect(
			resolveRecordingObjectKey(
				foreign,
				`${prefix}screenshot/screen-capture.jpg`,
			),
		).toBe(`${prefix}screenshot/screen-capture.jpg`);
	});
});
