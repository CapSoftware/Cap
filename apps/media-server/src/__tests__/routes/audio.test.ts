import { beforeEach, describe, expect, mock, test } from "bun:test";
import app from "../../app";
import * as ffmpeg from "../../lib/ffmpeg";

describe("POST /audio/check", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns 400 for missing videoUrl", async () => {
		const response = await app.fetch(
			new Request("http://localhost/audio/check", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			}),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 400 for invalid URL format", async () => {
		const response = await app.fetch(
			new Request("http://localhost/audio/check", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoUrl: "not-a-valid-url" }),
			}),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns hasAudio true when video has audio track", async () => {
		mock.module("../../lib/ffmpeg", () => ({
			checkHasAudioTrack: async () => true,
			extractAudio: ffmpeg.extractAudio,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			new Request("http://localhost/audio/check", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoUrl: "https://example.com/video.mp4" }),
			}),
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data).toEqual({ hasAudio: true });
	});

	test("returns hasAudio false when video has no audio track", async () => {
		mock.module("../../lib/ffmpeg", () => ({
			checkHasAudioTrack: async () => false,
			extractAudio: ffmpeg.extractAudio,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			new Request("http://localhost/audio/check", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoUrl: "https://example.com/video.mp4" }),
			}),
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data).toEqual({ hasAudio: false });
	});
});

describe("POST /audio/extract", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns 400 for missing videoUrl", async () => {
		const response = await app.fetch(
			new Request("http://localhost/audio/extract", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			}),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 400 for invalid URL format", async () => {
		const response = await app.fetch(
			new Request("http://localhost/audio/extract", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoUrl: "invalid-url" }),
			}),
		);

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 422 when video has no audio track", async () => {
		mock.module("../../lib/ffmpeg", () => ({
			checkHasAudioTrack: async () => false,
			extractAudio: ffmpeg.extractAudio,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			new Request("http://localhost/audio/extract", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoUrl: "https://example.com/video.mp4" }),
			}),
		);

		expect(response.status).toBe(422);
		const data = await response.json();
		expect(data.code).toBe("NO_AUDIO_TRACK");
	});

	test("returns audio data when extraction succeeds", async () => {
		const mockAudioData = new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74]);

		mock.module("../../lib/ffmpeg", () => ({
			checkHasAudioTrack: async () => true,
			extractAudio: async () => mockAudioData,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			new Request("http://localhost/audio/extract", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoUrl: "https://example.com/video.mp4" }),
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("audio/mp4");
		expect(response.headers.get("Content-Length")).toBe(
			mockAudioData.length.toString(),
		);

		const buffer = await response.arrayBuffer();
		expect(new Uint8Array(buffer)).toEqual(mockAudioData);
	});

	test("returns 500 when ffmpeg extraction fails", async () => {
		mock.module("../../lib/ffmpeg", () => ({
			checkHasAudioTrack: async () => true,
			extractAudio: async () => {
				throw new Error("FFmpeg failed");
			},
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			new Request("http://localhost/audio/extract", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoUrl: "https://example.com/video.mp4" }),
			}),
		);

		expect(response.status).toBe(500);
		const data = await response.json();
		expect(data.code).toBe("FFMPEG_ERROR");
		expect(data.details).toContain("FFmpeg failed");
	});
});
