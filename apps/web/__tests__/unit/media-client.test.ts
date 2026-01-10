import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkHasAudioTrackViaMediaServer,
	extractAudioViaMediaServer,
	isMediaServerConfigured,
} from "@/lib/media-client";

vi.mock("@cap/env", () => ({
	serverEnv: vi.fn(),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("media-client", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("isMediaServerConfigured", () => {
		it("returns true when MEDIA_SERVER_URL is set", async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValue({
				MEDIA_SERVER_URL: "http://localhost:3456",
			} as ReturnType<typeof serverEnv>);

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
			} as unknown as ReturnType<typeof serverEnv>);

			expect(isMediaServerConfigured()).toBe(false);
		});
	});

	describe("checkHasAudioTrackViaMediaServer", () => {
		beforeEach(async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValue({
				MEDIA_SERVER_URL: "http://localhost:3456",
			} as ReturnType<typeof serverEnv>);
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
					headers: { "Content-Type": "application/json" },
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
			vi.mocked(serverEnv).mockReturnValue({
				MEDIA_SERVER_URL: "http://localhost:3456",
			} as ReturnType<typeof serverEnv>);
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
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ videoUrl: "https://example.com/video.mp4" }),
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
});
