import type { VideoMetadata } from "@cap/database/types";
import { MAX_WEB_EDITOR_RECORDING_SEGMENTS } from "./editor-imports";
import { validEditorVideoAsset } from "./editor-video-upload";

export const MAX_WEB_EDITOR_CLIPS = 49;

type SavedClip = NonNullable<VideoMetadata["webEditorClips"]>["items"][number];
type SavedVideo = NonNullable<
	VideoMetadata["webEditorVideos"]
>["items"][number];

const CLIP_VIDEO_PATH =
	/^content\/videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm)$/;

function validClipMedia(
	value: string,
	videos: SavedVideo[],
	ownerId: string,
	videoId: string,
) {
	if (!CLIP_VIDEO_PATH.test(value)) return false;
	const asset = videos.find((item) => item.path === value);
	return !!asset && validEditorVideoAsset(asset, ownerId, videoId);
}

export function validWebEditorClip(
	clip: SavedClip,
	videos: SavedVideo[],
	ownerId: string,
	videoId: string,
) {
	const hasCamera = clip.cameraPath !== undefined;
	return (
		validClipMedia(clip.displayPath, videos, ownerId, videoId) &&
		Number.isFinite(clip.duration) &&
		clip.duration > 0 &&
		clip.duration <= 86_400 &&
		Number.isSafeInteger(clip.fps) &&
		clip.fps >= 1 &&
		clip.fps <= 120 &&
		typeof clip.hasAudio === "boolean" &&
		hasCamera === (clip.cameraFps !== undefined) &&
		hasCamera === (clip.cameraOffsetMs !== undefined) &&
		(!hasCamera ||
			(typeof clip.cameraPath === "string" &&
				clip.cameraPath !== clip.displayPath &&
				validClipMedia(clip.cameraPath, videos, ownerId, videoId) &&
				Number.isSafeInteger(clip.cameraFps) &&
				clip.cameraFps !== undefined &&
				clip.cameraFps >= 1 &&
				clip.cameraFps <= 120 &&
				Number.isSafeInteger(clip.cameraOffsetMs) &&
				clip.cameraOffsetMs !== undefined &&
				Math.abs(clip.cameraOffsetMs) <= 30_000))
	);
}

export function appendWebEditorClipToConfig(
	config: Record<string, unknown>,
	clipIndex: number,
	baseDuration: number,
	clipDuration: number,
): Record<string, unknown> | null {
	if (
		!Number.isSafeInteger(clipIndex) ||
		clipIndex < 1 ||
		clipIndex > MAX_WEB_EDITOR_RECORDING_SEGMENTS ||
		!Number.isFinite(baseDuration) ||
		baseDuration <= 0 ||
		!Number.isFinite(clipDuration) ||
		clipDuration <= 0
	) {
		return null;
	}
	const added = {
		recordingSegment: clipIndex,
		timescale: 1,
		start: 0,
		end: clipDuration,
	};
	const timeline = config.timeline;
	if (timeline === null || timeline === undefined) {
		return {
			...config,
			timeline: {
				segments: [
					{
						recordingSegment: 0,
						timescale: 1,
						start: 0,
						end: baseDuration,
					},
					added,
				],
				zoomSegments: [],
			},
		};
	}
	if (
		typeof timeline !== "object" ||
		Array.isArray(timeline) ||
		!Array.isArray((timeline as Record<string, unknown>).segments) ||
		!Array.isArray((timeline as Record<string, unknown>).zoomSegments)
	) {
		return null;
	}
	const savedTimeline = timeline as Record<string, unknown>;
	return {
		...config,
		timeline: {
			...savedTimeline,
			segments: [...(savedTimeline.segments as unknown[]), added],
		},
	};
}
