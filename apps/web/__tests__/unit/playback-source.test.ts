import { describe, expect, it, vi } from "vitest";
import {
	canPlayRawContentType,
	detectCrossOriginSupport,
	resolvePlaybackSource,
} from "@/app/s/[videoId]/_components/playback-source";

function createResponse(
	url: string,
	init: {
		status: number;
		headers?: Record<string, string>;
		redirected?: boolean;
	},
): Response {
	const response = new Response(null, {
		status: init.status,
		headers: init.headers,
	});

	Object.defineProperty(response, "url", {
		value: url,
		configurable: true,
	});
	Object.defineProperty(response, "redirected", {
		value: init.redirected ?? false,
		configurable: true,
	});

	return response;
}

describe("detectCrossOriginSupport", () => {
	it("disables cross-origin for S3 and R2 URLs", () => {
		expect(
			detectCrossOriginSupport(
				"https://cap-assets.r2.cloudflarestorage.com/video.mp4",
			),
		).toBe(false);
		expect(
			detectCrossOriginSupport(
				"https://bucket.s3.eu-west-2.amazonaws.com/video.mp4",
			),
		).toBe(false);
		expect(detectCrossOriginSupport("/api/playlist?videoType=mp4")).toBe(true);
	});
});

describe("canPlayRawContentType", () => {
	it("treats mp4 raw uploads as playable without probing browser support", () => {
		expect(
			canPlayRawContentType("video/mp4", "https://cap.so/raw-upload.mp4"),
		).toBe(true);
	});

	it("checks browser support for webm raw uploads", () => {
		expect(
			canPlayRawContentType(
				"video/webm;codecs=vp9,opus",
				"https://cap.so/raw-upload.webm",
				() => ({
					canPlayType: vi.fn().mockReturnValue("probably"),
				}),
			),
		).toBe(true);
		expect(
			canPlayRawContentType(
				"video/webm;codecs=vp9,opus",
				"https://cap.so/raw-upload.webm",
				() => ({
					canPlayType: vi.fn().mockReturnValue(""),
				}),
			),
		).toBe(false);
	});
});

describe("resolvePlaybackSource", () => {
	it("returns the MP4 source immediately when it is available", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
			createResponse("https://bucket.s3.amazonaws.com/result.mp4", {
				status: 206,
				redirected: true,
			}),
		);

		const result = await resolvePlaybackSource({
			videoSrc: "/api/playlist?videoType=mp4",
			rawFallbackSrc: "/api/playlist?videoType=raw-preview",
			enableCrossOrigin: true,
			fetchImpl,
			now: () => 123,
		});

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/playlist?videoType=mp4&_t=123",
			{
				headers: { range: "bytes=0-0" },
			},
		);
		expect(result).toEqual({
			url: "https://bucket.s3.amazonaws.com/result.mp4",
			type: "mp4",
			supportsCrossOrigin: false,
		});
	});

	it("falls back to the raw preview when the MP4 probe fails", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				createResponse("/api/playlist?videoType=mp4&_t=200", { status: 404 }),
			)
			.mockResolvedValueOnce(
				createResponse("https://cap.so/raw-upload.mp4", {
					status: 206,
					headers: { "content-type": "video/mp4" },
					redirected: true,
				}),
			);

		const result = await resolvePlaybackSource({
			videoSrc: "/api/playlist?videoType=mp4",
			rawFallbackSrc: "/api/playlist?videoType=raw-preview",
			enableCrossOrigin: true,
			fetchImpl,
			now: () => 200,
		});

		expect(fetchImpl).toHaveBeenNthCalledWith(
			1,
			"/api/playlist?videoType=mp4&_t=200",
			{
				headers: { range: "bytes=0-0" },
			},
		);
		expect(fetchImpl).toHaveBeenNthCalledWith(
			2,
			"/api/playlist?videoType=raw-preview&_t=200",
			{
				headers: { range: "bytes=0-0" },
			},
		);
		expect(result).toEqual({
			url: "https://cap.so/raw-upload.mp4",
			type: "raw",
			supportsCrossOrigin: true,
		});
	});

	it("rejects raw webm previews when the browser cannot play them", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				createResponse("/api/playlist?videoType=mp4&_t=300", { status: 404 }),
			)
			.mockResolvedValueOnce(
				createResponse("https://cap.so/raw-upload.webm", {
					status: 206,
					headers: { "content-type": "video/webm;codecs=vp9,opus" },
					redirected: true,
				}),
			);

		const result = await resolvePlaybackSource({
			videoSrc: "/api/playlist?videoType=mp4",
			rawFallbackSrc: "/api/playlist?videoType=raw-preview",
			fetchImpl,
			now: () => 300,
			createVideoElement: () => ({
				canPlayType: vi.fn().mockReturnValue(""),
			}),
		});

		expect(result).toBeNull();
	});

	it("falls back after MP4 network errors and returns null when no source works", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new Error("network"))
			.mockResolvedValueOnce(
				createResponse("/api/playlist?videoType=raw-preview&_t=400", {
					status: 404,
				}),
			);

		const result = await resolvePlaybackSource({
			videoSrc: "/api/playlist?videoType=mp4",
			rawFallbackSrc: "/api/playlist?videoType=raw-preview",
			fetchImpl,
			now: () => 400,
		});

		expect(result).toBeNull();
	});
});
