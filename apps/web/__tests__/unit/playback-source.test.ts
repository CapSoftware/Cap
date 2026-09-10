import { describe, expect, it, vi } from "vitest";
import {
	canPlayRawContentType,
	detectCrossOriginSupport,
	resolvePlaybackSource,
	shouldFallbackToRawPlaybackSource,
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
	it("disables cross-origin for S3 and R2 URLs when not redirected", () => {
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

	it("enables cross-origin for S3/R2 URLs when probe was redirected", () => {
		expect(
			detectCrossOriginSupport(
				"https://cap-assets.r2.cloudflarestorage.com/video.mp4",
				true,
			),
		).toBe(true);
		expect(
			detectCrossOriginSupport(
				"https://bucket.s3.eu-west-2.amazonaws.com/video.mp4",
				true,
			),
		).toBe(true);
	});

	it("falls back to hostname heuristic when not redirected", () => {
		expect(
			detectCrossOriginSupport(
				"https://cap-assets.r2.cloudflarestorage.com/video.mp4",
				false,
			),
		).toBe(false);
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
	it("uses the page's signed URL without a playlist request or changing its signature", async () => {
		const initialUrl =
			"https://bucket.s3.amazonaws.com/result.mp4?signature=abc";
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
			createResponse(initialUrl, {
				status: 206,
				redirected: false,
			}),
		);
		expect(
			await resolvePlaybackSource({
				videoSrc: "/api/playlist?videoType=mp4",
				initialUrl,
				enableCrossOrigin: true,
				fetchImpl,
				now: () => 123,
			}),
		).toEqual({ url: initialUrl, type: "mp4", supportsCrossOrigin: true });
		expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(initialUrl, {
			headers: { range: "bytes=0-0" },
		});
	});

	it.each([401, 403, 404, 500])(
		"refreshes a failed initial URL through the authorized playlist route (HTTP %s)",
		async (status) => {
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(new Response(null, { status }))
				.mockResolvedValueOnce(
					createResponse("https://media.example.com/fresh.mp4", {
						status: 206,
						redirected: true,
					}),
				);
			expect(
				await resolvePlaybackSource({
					videoSrc: "/api/playlist?videoType=mp4",
					initialUrl: "https://media.example.com/expired.mp4",
					fetchImpl,
					now: () => 123,
				}),
			).toMatchObject({
				url: "https://media.example.com/fresh.mp4",
				type: "mp4",
			});
			expect(fetchImpl).toHaveBeenCalledTimes(2);
			expect(fetchImpl).toHaveBeenLastCalledWith(
				"/api/playlist?videoType=mp4&_t=123",
				{ headers: { range: "bytes=0-0" } },
			);
		},
	);

	it("uses native playback without repeating a CORS-blocked signed probe", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new TypeError("CORS"));
		expect(
			await resolvePlaybackSource({
				videoSrc: "/api/playlist?videoType=mp4",
				initialUrl: "https://media.example.com/result.mp4",
				fetchImpl,
				enableCrossOrigin: true,
				now: () => 123,
			}),
		).toEqual({
			url: "/api/playlist?videoType=mp4&_t=123",
			type: "mp4",
			supportsCrossOrigin: false,
		});
		expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
			"https://media.example.com/result.mp4",
			{ headers: { range: "bytes=0-0" } },
		);
	});

	it("preserves the raw fallback after the initial and refreshed MP4 are missing", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValueOnce(
				createResponse("https://media.example.com/raw.webm", {
					status: 206,
					headers: { "content-type": "video/webm" },
					redirected: true,
				}),
			);
		expect(
			await resolvePlaybackSource({
				videoSrc: "/api/playlist?videoType=mp4",
				initialUrl: "https://media.example.com/result.mp4",
				rawFallbackSrc: "/api/playlist?videoType=raw-preview",
				fetchImpl,
				createVideoElement: () => ({ canPlayType: () => "probably" }),
			}),
		).toMatchObject({ type: "raw", url: "https://media.example.com/raw.webm" });
	});

	it("does not retry the initial MP4 when switching to raw playback", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				createResponse("https://media.example.com/raw.mp4", { status: 206 }),
			);
		expect(
			await resolvePlaybackSource({
				videoSrc: "/api/playlist?videoType=mp4",
				initialUrl: "https://media.example.com/result.mp4",
				rawFallbackSrc: "/api/playlist?videoType=raw-preview",
				preferredSource: "raw",
				fetchImpl,
				now: () => 123,
			}),
		).toMatchObject({ type: "raw" });
		expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
			"/api/playlist?videoType=raw-preview&_t=123",
			{ headers: { range: "bytes=0-0" } },
		);
	});

	it.each([200, 206, 404])(
		"closes the probe body after reading HTTP %s headers",
		async (status) => {
			const cancel = vi.fn();
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValue(
					new Response(new ReadableStream({ cancel }), { status }),
				);
			const result = await resolvePlaybackSource({
				videoSrc: "/api/playlist?videoType=mp4",
				fetchImpl,
			});
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			if (status === 404) expect(result).toBeNull();
			else expect(result?.type).toBe("mp4");
		},
	);

	it("keeps a playable source when closing its probe body fails", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				new ReadableStream({
					cancel: () => Promise.reject(new Error("Connection closed")),
				}),
				{ status: 206 },
			),
		);
		const result = await resolvePlaybackSource({
			videoSrc: "https://v.cap.so/result.mp4",
			fetchImpl,
		});
		expect(result?.type).toBe("mp4");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("closes both probes while retaining the raw preview content type", async () => {
		const cancelMp4 = vi.fn();
		const cancelRaw = vi.fn();
		const canPlayType = vi.fn().mockReturnValue("probably");
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(new ReadableStream({ cancel: cancelMp4 }), {
					status: 404,
				}),
			)
			.mockResolvedValueOnce(
				new Response(new ReadableStream({ cancel: cancelRaw }), {
					status: 206,
					headers: { "Content-Type": "video/webm;codecs=vp9,opus" },
				}),
			);
		const result = await resolvePlaybackSource({
			videoSrc: "/api/playlist?videoType=mp4",
			rawFallbackSrc: "/api/playlist?videoType=raw-preview",
			fetchImpl,
			createVideoElement: () => ({ canPlayType }),
		});
		expect(result?.type).toBe("raw");
		expect(cancelMp4).toHaveBeenCalledTimes(1);
		expect(cancelRaw).toHaveBeenCalledTimes(1);
		expect(canPlayType).toHaveBeenCalledWith("video/webm;codecs=vp9,opus");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

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
			supportsCrossOrigin: true,
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

	it("can prefer the raw preview after the MP4 source fails in the player", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
			createResponse("https://cap.so/raw-upload.webm", {
				status: 206,
				headers: { "content-type": "video/webm;codecs=vp9,opus" },
				redirected: true,
			}),
		);

		const result = await resolvePlaybackSource({
			videoSrc: "/api/playlist?videoType=mp4",
			rawFallbackSrc: "/api/playlist?videoType=raw-preview",
			preferredSource: "raw",
			fetchImpl,
			now: () => 250,
			createVideoElement: () => ({
				canPlayType: vi.fn().mockReturnValue("probably"),
			}),
		});

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/playlist?videoType=raw-preview&_t=250",
			{
				headers: { range: "bytes=0-0" },
			},
		);
		expect(result).toEqual({
			url: "https://cap.so/raw-upload.webm",
			type: "raw",
			supportsCrossOrigin: false,
		});
	});

	it.each([206, 404])(
		"rechecks the processed MP4 once when a preferred raw upload is gone (HTTP %s)",
		async (status) => {
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(
					createResponse("/raw-upload.webm", { status: 404 }),
				)
				.mockResolvedValueOnce(
					createResponse("https://v.cap.so/result.mp4", {
						status,
						redirected: true,
					}),
				);
			const result = await resolvePlaybackSource({
				videoSrc: "/api/playlist?videoType=mp4",
				rawFallbackSrc: "/api/playlist?videoType=raw-preview",
				preferredSource: "raw",
				fetchImpl,
				now: () => 275,
			});
			expect(fetchImpl).toHaveBeenCalledTimes(2);
			expect(fetchImpl).toHaveBeenNthCalledWith(
				2,
				"/api/playlist?videoType=mp4&_t=275",
				{ headers: { range: "bytes=0-0" } },
			);
			if (status === 206) expect(result?.type).toBe("mp4");
			else expect(result).toBeNull();
		},
	);

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

	it("uses a same-origin MP4 source when the probe is blocked after redirect", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new TypeError("Failed to fetch"));

		const result = await resolvePlaybackSource({
			videoSrc: "/api/playlist?videoType=mp4",
			rawFallbackSrc: "/api/playlist?videoType=raw-preview",
			enableCrossOrigin: true,
			fetchImpl,
			now: () => 350,
		});

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/playlist?videoType=mp4&_t=350",
			{
				headers: { range: "bytes=0-0" },
			},
		);
		expect(result).toEqual({
			url: "/api/playlist?videoType=mp4&_t=350",
			type: "mp4",
			supportsCrossOrigin: false,
		});
	});

	it("falls back after absolute MP4 network errors and returns null when no source works", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new Error("network"))
			.mockResolvedValueOnce(
				createResponse("/api/playlist?videoType=raw-preview&_t=400", {
					status: 404,
				}),
			);

		const result = await resolvePlaybackSource({
			videoSrc: "https://cap.so/api/playlist?videoType=mp4",
			rawFallbackSrc: "/api/playlist?videoType=raw-preview",
			fetchImpl,
			now: () => 400,
		});

		expect(result).toBeNull();
	});
});

describe("shouldFallbackToRawPlaybackSource", () => {
	it("allows a single mp4-to-raw fallback", () => {
		expect(shouldFallbackToRawPlaybackSource("mp4", "/raw", false)).toBe(true);
		expect(shouldFallbackToRawPlaybackSource("mp4", "/raw", true)).toBe(false);
		expect(shouldFallbackToRawPlaybackSource("raw", "/raw", true)).toBe(false);
		expect(shouldFallbackToRawPlaybackSource("mp4", undefined, false)).toBe(
			false,
		);
	});
});
