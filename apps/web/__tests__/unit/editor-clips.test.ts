import type { VideoMetadata } from "@cap/database/types";
import { expect, test } from "vitest";
import {
	appendWebEditorClipToConfig,
	validWebEditorClip,
} from "../../lib/editor-clips";

type Clip = NonNullable<VideoMetadata["webEditorClips"]>["items"][number];
type Asset = NonNullable<VideoMetadata["webEditorVideos"]>["items"][number];

const ownerId = "owner";
const videoId = "video";
const displayPath = "content/videos/00000000-0000-0000-0000-000000000001.mp4";
const cameraPath = "content/videos/00000000-0000-0000-0000-000000000002.webm";

function asset(path: string, contentType: string): Asset {
	return {
		path,
		key: `${ownerId}/${videoId}/editor-assets/videos/${path.slice("content/videos/".length)}`,
		name: "Saved recording source",
		contentType,
		size: 32_000,
		objectIdentity: null,
	};
}

test("a saved screen and separate camera clip can only use assets from its own recording", () => {
	const assets = [
		asset(displayPath, "video/mp4"),
		asset(cameraPath, "video/webm"),
	];
	const clip: Clip = {
		displayPath,
		duration: 8.5,
		fps: 30,
		hasAudio: false,
		cameraPath,
		cameraFps: 25,
		cameraOffsetMs: 125,
	};
	expect(validWebEditorClip(clip, assets, ownerId, videoId)).toBe(true);
	expect(validWebEditorClip(clip, assets, "another-owner", videoId)).toBe(
		false,
	);
	expect(
		validWebEditorClip(
			{ ...clip, cameraOffsetMs: 30_001 },
			assets,
			ownerId,
			videoId,
		),
	).toBe(false);
	expect(
		validWebEditorClip(
			{ ...clip, cameraFps: undefined },
			assets,
			ownerId,
			videoId,
		),
	).toBe(false);
	expect(
		validWebEditorClip(
			{ ...clip, cameraPath: displayPath },
			assets,
			ownerId,
			videoId,
		),
	).toBe(false);
});

test("adding a recording clip keeps existing trims, zooms, and other project settings", () => {
	const source = {
		camera: { hide: false },
		clips: [{ index: 0, offsets: { camera: 0.125 } }],
		timeline: {
			segments: [
				{ recordingSegment: 0, timescale: 1, start: 2, end: 6 },
				{ recordingSegment: 0, timescale: 0.5, start: 12, end: 16 },
			],
			zoomSegments: [{ start: 1, end: 2, amount: 1.5 }],
		},
	};
	const added = appendWebEditorClipToConfig(source, 1, 20, 8.5);
	expect(added).not.toBeNull();
	expect(added?.camera).toBe(source.camera);
	expect(added?.clips).toBe(source.clips);
	expect(added?.timeline).toEqual({
		segments: [
			...source.timeline.segments,
			{ recordingSegment: 1, timescale: 1, start: 0, end: 8.5 },
		],
		zoomSegments: source.timeline.zoomSegments,
	});
	expect(source.timeline.segments).toHaveLength(2);
});

test("the first added clip creates a base timeline without mutating the saved config", () => {
	const source = { camera: { hide: true } };
	expect(appendWebEditorClipToConfig(source, 1, 12, 3)).toEqual({
		camera: source.camera,
		timeline: {
			segments: [
				{ recordingSegment: 0, timescale: 1, start: 0, end: 12 },
				{ recordingSegment: 1, timescale: 1, start: 0, end: 3 },
			],
			zoomSegments: [],
		},
	});
	expect(source).not.toHaveProperty("timeline");
	expect(appendWebEditorClipToConfig(source, 0, 12, 3)).toBeNull();
	expect(appendWebEditorClipToConfig(source, 1001, 12, 3)).toBeNull();
	expect(appendWebEditorClipToConfig(source, 1, 12, Number.NaN)).toBeNull();
});

test("an MP4 after a multi-clip Cap import uses the next recording segment index", () => {
	const source = {
		timeline: {
			segments: [
				{ recordingSegment: 0, timescale: 1, start: 0, end: 10 },
				{ recordingSegment: 1, timescale: 1.5, start: 0.2, end: 1.6 },
				{ recordingSegment: 2, timescale: 1, start: 0, end: 1.2 },
			],
			zoomSegments: [],
		},
	};
	expect(appendWebEditorClipToConfig(source, 3, 10, 2)?.timeline).toEqual({
		segments: [
			...source.timeline.segments,
			{ recordingSegment: 3, timescale: 1, start: 0, end: 2 },
		],
		zoomSegments: [],
	});
});
