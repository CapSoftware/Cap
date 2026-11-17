import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkHasAudioTrackViaMediaServer,
	extractAudioViaMediaServer,
	fetchConvertedVideoViaMediaServer,
	isMediaServerConfigured,
	probeVideoViaMediaServer,
} from "@/lib/media-client";

vi.mock("@cap/env", () => ({
	serverEnv: vi.fn(),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mediaServerEnv = {
	MEDIA_SERVER_URL: "http://localhost:3456",
	MEDIA_SERVER_WEBHOOK_SECRET: "test-secret",
};

const mediaServerHeaders = {
	"Content-Type": "application/json",
	"x-media-server-secret": "test-secret",
};

describe("media-client", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("isMediaServerConfigured", () => {
		it("returns true when MEDIA_SERVER_URL is set", async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValue(
				mediaServerEnv as ReturnType<typeof serverEnv>,
			);

			expect(isMediaServerConfigured()).toBe(true);
		});

		it("returns false when MEDIA_SERVER_URL is not set", async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValue({
				MEDIA_SERVER_URL: undefined,
			} as unknown as ReturnType<typeof serverEnv>);

			expect(isMediaServerConfigured()).toBe(false);
		});

		it("returns false when MEDIA_SERVER_URL is empty string", async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValue({
				MEDIA_SERVER_URL: "",
				MEDIA_SERVER_WEBHOOK_SECRET: "test-secret",
			} as unknown as ReturnType<typeof serverEnv>);

			expect(isMediaServerConfigured()).toBe(false);
		});

		it("returns false when MEDIA_SERVER_WEBHOOK_SECRET is missing", async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValue({
				MEDIA_SERVER_URL: "http://localhost:3456",
				MEDIA_SERVER_WEBHOOK_SECRET: undefined,
			} as unknown as ReturnType<typeof serverEnv>);

			expect(isMediaServerConfigured()).toBe(false);
		});
	});

	describe("checkHasAudioTrackViaMediaServer", () => {
		beforeEach(async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValue(
				mediaServerEnv as ReturnType<typeof serverEnv>,
			);
		});

		it("throws error when MEDIA_SERVER_URL is not configured", async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValue({
				MEDIA_SERVER_URL: undefined,
			} as unknown as ReturnType<typeof serverEnv>);

			await expect(
				checkHasAudioTrackViaMediaServer("https://example.com/video.mp4"),
			).rejects.toThrow("MEDIA_SERVER_URL is not configured");
		});

		it("throws error when MEDIA_SERVER_WEBHOOK_SECRET is not configured", async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValue({
				MEDIA_SERVER_URL: "http://localhost:3456",
				MEDIA_SERVER_WEBHOOK_SECRET: undefined,
			} as unknown as ReturnType<typeof serverEnv>);

			await expect(
				checkHasAudioTrackViaMediaServer("https://example.com/video.mp4"),
			).rejects.toThrow("MEDIA_SERVER_WEBHOOK_SECRET is not configured");
		});

		it("returns true when video has audio track", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ hasAudio: true }),
			});

			const result = await checkHasAudioTrackViaMediaServer(
				"https://example.com/video.mp4",
			);

			expect(result).toBe(true);
			expect(mockFetch).toHaveBeenCalledWith(
				"http://localhost:3456/audio/check",
				{
					method: "POST",
					headers: mediaServerHeaders,
					body: JSON.stringify({ videoUrl: "https://example.com/video.mp4" }),
				},
			);
		});

		it("returns false when video has no audio track", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ hasAudio: false }),
			});

			const result = await checkHasAudioTrackViaMediaServer(
				"https://example.com/video.mp4",
			);

			expect(result).toBe(false);
		});

		it("throws error when media server returns error", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				json: async () => ({
					error: "FFMPEG_ERROR",
					code: "FFMPEG_ERROR",
					details: "FFmpeg process failed",
				}),
			});

			await expect(
				checkHasAudioTrackViaMediaServer("https://example.com/video.mp4"),
			).rejects.toThrow("FFMPEG_ERROR");
		});
	});

	describe("extractAudioViaMediaServer", () => {
		beforeEach(async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValue(
				mediaServerEnv as ReturnType<typeof serverEnv>,
			);
		});

		it("throws error when MEDIA_SERVER_URL is not configured", async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValue({
				MEDIA_SERVER_URL: undefined,
			} as unknown as ReturnType<typeof serverEnv>);

			await expect(
				extractAudioViaMediaServer("https://example.com/video.mp4"),
			).rejects.toThrow("MEDIA_SERVER_URL is not configured");
		});

		it("returns audio buffer when extraction succeeds", async () => {
			const mockAudioData = new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66]);
			mockFetch.mockResolvedValueOnce({
				ok: true,
				arrayBuffer: async () => mockAudioData.buffer,
			});

			const result = await extractAudioViaMediaServer(
				"https://example.com/video.mp4",
			);

			expect(result).toBeInstanceOf(Buffer);
			expect(result.length).toBe(mockAudioData.length);
			expect(mockFetch).toHaveBeenCalledWith(
				"http://localhost:3456/audio/extract",
				{
					method: "POST",
					headers: mediaServerHeaders,
					body: JSON.stringify({
						videoUrl: "https://example.com/video.mp4",
						stream: true,
					}),
				},
			);
		});

		it("throws NO_AUDIO_TRACK error when video has no audio", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				json: async () => ({
					error: "Video has no audio track",
					code: "NO_AUDIO_TRACK",
				}),
			});

			await expect(
				extractAudioViaMediaServer("https://example.com/video.mp4"),
			).rejects.toThrow("NO_AUDIO_TRACK");
		});

		it("throws error when extraction fails", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				json: async () => ({
					error: "Failed to extract audio",
					code: "FFMPEG_ERROR",
					details: "FFmpeg process exited with code 1",
				}),
			});

			await expect(
				extractAudioViaMediaServer("https://example.com/video.mp4"),
			).rejects.toThrow("FFmpeg process exited with code 1");
		});
	});

	describe("probeVideoViaMediaServer", () => {
		beforeEach(async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValue(
				mediaServerEnv as ReturnType<typeof serverEnv>,
			);
		});

		it("returns authoritative media metadata", async () => {
			const metadata = {
				duration: 42,
				width: 1920,
				height: 1080,
				fps: 30,
				videoCodec: "h264",
				audioCodec: "aac",
				audioChannels: 2,
				sampleRate: 48_000,
				bitrate: 1_000_000,
				fileSize: 5_000_000,
			};
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ metadata }),
			});

			await expect(
				probeVideoViaMediaServer("https://example.com/video.mp4"),
			).resolves.toEqual(metadata);
		});

		it("can disable request retries for synchronous entitlement checks", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 503,
				json: async () => ({
					error: "Server is busy",
					code: "SERVER_BUSY",
				}),
			});

			await expect(
				probeVideoViaMediaServer("https://example.com/video.mp4", {
					maxRetries: 0,
				}),
			).rejects.toThrow("Server is busy");
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});
	});

	describe("fetchConvertedVideoViaMediaServer", () => {
		beforeEach(async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValue(
				mediaServerEnv as ReturnType<typeof serverEnv>,
			);
		});

		it("throws error when MEDIA_SERVER_URL is not configured", async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValue({
				MEDIA_SERVER_URL: undefined,
			} as unknown as ReturnType<typeof serverEnv>);

			await expect(
				fetchConvertedVideoViaMediaServer("https://example.com/video.m3u8"),
			).rejects.toThrow("MEDIA_SERVER_URL is not configured");
		});

		it("posts conversion request to the media server", async () => {
			const mockResponse = {
				ok: true,
				status: 200,
			} as Response;
			mockFetch.mockResolvedValueOnce(mockResponse);

			const result = await fetchConvertedVideoViaMediaServer(
				"https://example.com/video.m3u8",
				".m3u8",
			);

			expect(result).toBe(mockResponse);
			expect(mockFetch).toHaveBeenCalledWith(
				"http://localhost:3456/video/convert",
				{
					method: "POST",
					headers: mediaServerHeaders,
					body: JSON.stringify({
						videoUrl: "https://example.com/video.m3u8",
						inputExtension: ".m3u8",
					}),
				},
			);
		});

		it("does not retry conversion failures that would repeat heavyweight work", async () => {
			const mockResponse = {
				ok: false,
				status: 502,
			} as Response;
			mockFetch.mockResolvedValueOnce(mockResponse);

			const result = await fetchConvertedVideoViaMediaServer(
				"https://example.com/video.m3u8",
				".m3u8",
			);

			expect(result).toBe(mockResponse);
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});
	});
});

describe("media-client retry body ownership", () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		mockFetch.mockReset();
		const { serverEnv } = await import("@cap/env");
		vi.mocked(serverEnv).mockReturnValue(
			mediaServerEnv as ReturnType<typeof serverEnv>,
		);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const retryResponse = (status: number, cancel = vi.fn(async () => {})) => ({
		response: new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("upstream unavailable"));
				},
				cancel,
			}),
			{ status },
		),
		cancel,
	});

	it.each([502, 503, 504])(
		"cancels a discarded %s body before retrying",
		async (status) => {
			const order: string[] = [];
			const discarded = retryResponse(
				status,
				vi.fn(async () => {
					order.push("cancel");
				}),
			);
			mockFetch.mockImplementationOnce(async () => {
				order.push("first fetch");
				return discarded.response;
			});
			mockFetch.mockImplementationOnce(async () => {
				order.push("second fetch");
				return Response.json({ metadata: { duration: 42 } });
			});
			const pending = probeVideoViaMediaServer(
				"https://example.com/video.mp4",
				{ maxRetries: 1 },
			);
			await vi.runAllTimersAsync();
			await expect(pending).resolves.toEqual({ duration: 42 });
			expect(order).toEqual(["first fetch", "cancel", "second fetch"]);
			expect(discarded.response.bodyUsed).toBe(true);
		},
	);

	it("still retries when discarded-body cancellation rejects", async () => {
		const discarded = retryResponse(
			503,
			vi.fn(async () => {
				throw new Error("connection already closed");
			}),
		);
		mockFetch.mockResolvedValueOnce(discarded.response);
		mockFetch.mockResolvedValueOnce(
			Response.json({ metadata: { duration: 42 } }),
		);
		const pending = probeVideoViaMediaServer("https://example.com/video.mp4", {
			maxRetries: 1,
		});
		await vi.runAllTimersAsync();
		await expect(pending).resolves.toEqual({ duration: 42 });
		expect(discarded.cancel).toHaveBeenCalledTimes(1);
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("preserves the final retryable response for the caller's error parser", async () => {
		const discarded = retryResponse(503);
		const final = Response.json(
			{ error: "still busy", code: "SERVER_BUSY" },
			{ status: 503 },
		);
		if (!final.body) throw new Error("Expected an error response body");
		const cancelFinal = vi.spyOn(final.body, "cancel");
		mockFetch.mockResolvedValueOnce(discarded.response);
		mockFetch.mockResolvedValueOnce(final);
		const rejected = probeVideoViaMediaServer("https://example.com/video.mp4", {
			maxRetries: 1,
		}).catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		expect(await rejected).toMatchObject({ message: "still busy" });
		expect(discarded.cancel).toHaveBeenCalledTimes(1);
		expect(cancelFinal).not.toHaveBeenCalled();
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("does not cancel a nonretryable error before parsing it", async () => {
		const response = Response.json(
			{ error: "invalid source", code: "BAD_REQUEST" },
			{ status: 400 },
		);
		if (!response.body) throw new Error("Expected an error response body");
		const cancel = vi.spyOn(response.body, "cancel");
		mockFetch.mockResolvedValueOnce(response);
		await expect(
			probeVideoViaMediaServer("https://example.com/video.mp4"),
		).rejects.toThrow("invalid source");
		expect(cancel).not.toHaveBeenCalled();
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it.each([200, 502])(
		"keeps a conversion's %s response stream readable without retries",
		async (status) => {
			const response = new Response("converted bytes or final error", {
				status,
			});
			if (!response.body) throw new Error("Expected a response body");
			const cancel = vi.spyOn(response.body, "cancel");
			mockFetch.mockResolvedValueOnce(response);
			const result = await fetchConvertedVideoViaMediaServer(
				"https://example.com/video.m3u8",
			);
			expect(result).toBe(response);
			expect(result.bodyUsed).toBe(false);
			expect(await result.text()).toBe("converted bytes or final error");
			expect(cancel).not.toHaveBeenCalled();
			expect(mockFetch).toHaveBeenCalledTimes(1);
		},
	);

	it("retries an empty response body", async () => {
		mockFetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
		mockFetch.mockResolvedValueOnce(
			Response.json({ metadata: { duration: 42 } }),
		);
		const pending = probeVideoViaMediaServer("https://example.com/video.mp4", {
			maxRetries: 1,
		});
		await vi.runAllTimersAsync();
		await expect(pending).resolves.toEqual({ duration: 42 });
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});
});
