import { describe, expect, it } from "vitest";
import {
	baseContentType,
	commentMediaExtension,
	commentMediaKeys,
	MAX_WAVEFORM_PEAKS,
	sanitizeWaveform,
} from "@/lib/comment-media";

describe("baseContentType", () => {
	it("strips MediaRecorder codec suffixes and normalizes case", () => {
		expect(baseContentType("audio/webm;codecs=opus")).toBe("audio/webm");
		expect(baseContentType("Video/MP4; codecs=avc1")).toBe("video/mp4");
		expect(baseContentType("video/mp4")).toBe("video/mp4");
	});
});

describe("commentMediaExtension", () => {
	it("never maps webm video to an audio extension", () => {
		expect(commentMediaExtension("video", "video/webm")).toBe("webm");
		expect(commentMediaExtension("audio", "audio/webm")).toBe("webm");
		// The signed-upload route's inference bug this replaces: a video kind
		// must not accept audio types at all.
		expect(commentMediaExtension("video", "audio/webm")).toBeNull();
	});

	it("rejects types outside the allowlist", () => {
		expect(commentMediaExtension("video", "image/gif")).toBeNull();
		expect(
			commentMediaExtension("audio", "application/octet-stream"),
		).toBeNull();
		expect(commentMediaExtension("video", "video/x-matroska")).toBeNull();
	});
});

describe("commentMediaKeys", () => {
	const input = {
		ownerId: "owner-1",
		videoId: "video-1",
		commentId: "comment-1",
	};

	it("derives keys under the parent video's comments prefix", () => {
		expect(
			commentMediaKeys({
				...input,
				kind: "video",
				contentType: "video/mp4;codecs=avc1",
				withThumbnail: true,
			}),
		).toEqual({
			contentType: "video/mp4",
			key: "owner-1/video-1/comments/comment-1/media.mp4",
			thumbnailKey: "owner-1/video-1/comments/comment-1/thumbnail.jpg",
		});
	});

	it("only video comments get thumbnails", () => {
		expect(
			commentMediaKeys({
				...input,
				kind: "audio",
				contentType: "audio/webm;codecs=opus",
				withThumbnail: true,
			}),
		).toEqual({
			contentType: "audio/webm",
			key: "owner-1/video-1/comments/comment-1/media.webm",
			thumbnailKey: null,
		});
	});

	it("returns null for disallowed content types", () => {
		expect(
			commentMediaKeys({ ...input, kind: "video", contentType: "image/png" }),
		).toBeNull();
	});
});

describe("sanitizeWaveform", () => {
	it("clamps values to 0..1 and zeroes non-finite entries", () => {
		expect(sanitizeWaveform([0.5, -1, 2, Number.NaN, Infinity])).toEqual([
			0.5, 0, 1, 0, 0,
		]);
	});

	it("caps the number of peaks", () => {
		const peaks = sanitizeWaveform(new Array(10_000).fill(0.5));
		expect(peaks).toHaveLength(MAX_WAVEFORM_PEAKS);
	});

	it("returns undefined for empty input", () => {
		expect(sanitizeWaveform(undefined)).toBeUndefined();
		expect(sanitizeWaveform([])).toBeUndefined();
	});
});
