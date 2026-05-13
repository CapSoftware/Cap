import { beforeEach, describe, expect, mock, test } from "bun:test";
import app from "../../app";
import * as ffmpeg from "../../lib/ffmpeg";

const MEDIA_SERVER_SECRET = "test-secret";
const AUTH_HEADERS = {
	"Content-Type": "application/json",
	"x-media-server-secret": MEDIA_SERVER_SECRET,
};

process.env.MEDIA_SERVER_WEBHOOK_SECRET = MEDIA_SERVER_SECRET;

function audioPostRequest(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: AUTH_HEADERS,
		body: JSON.stringify(body),
	});
}

function unauthenticatedAudioPostRequest(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /audio/check", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns 401 without media server secret", async () => {
		const response = await app.fetch(
			unauthenticatedAudioPostRequest("/audio/check", {
				videoUrl: "https://example.com/video.mp4",
			}),
		);

		expect(response.status).toBe(401);
	});

	test("returns 400 for missing videoUrl", async () => {
		const response = await app.fetch(audioPostRequest("/audio/check", {}));

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 400 for invalid URL format", async () => {
		const response = await app.fetch(
			audioPostRequest("/audio/check", { videoUrl: "not-a-valid-url" }),
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
			audioPostRequest("/audio/check", {
				videoUrl: "https://example.com/video.mp4",
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
			audioPostRequest("/audio/check", {
				videoUrl: "https://example.com/video.mp4",
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

	test("returns 401 without media server secret", async () => {
		const response = await app.fetch(
			unauthenticatedAudioPostRequest("/audio/extract", {
				videoUrl: "https://example.com/video.mp4",
			}),
		);

		expect(response.status).toBe(401);
	});

	test("returns 400 for missing videoUrl", async () => {
		const response = await app.fetch(audioPostRequest("/audio/extract", {}));

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns 400 for invalid URL format", async () => {
		const response = await app.fetch(
			audioPostRequest("/audio/extract", { videoUrl: "invalid-url" }),
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
			audioPostRequest("/audio/extract", {
				videoUrl: "https://example.com/video.mp4",
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
			audioPostRequest("/audio/extract", {
				videoUrl: "https://example.com/video.mp4",
				stream: false,
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
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
			audioPostRequest("/audio/extract", {
				videoUrl: "https://example.com/video.mp4",
				stream: false,
			}),
		);

		expect(response.status).toBe(500);
		const data = await response.json();
		expect(data.code).toBe("FFMPEG_ERROR");
		expect(data.details).toContain("FFmpeg failed");
	});
});

describe("POST /audio/convert", () => {
	beforeEach(() => {
		mock.restore();
	});

	test("returns 401 without media server secret", async () => {
		const response = await app.fetch(
			unauthenticatedAudioPostRequest("/audio/convert", {
				audioUrl: "https://example.com/audio.wav",
			}),
		);

		expect(response.status).toBe(401);
	});

	test("returns 400 for missing audioUrl", async () => {
		const response = await app.fetch(audioPostRequest("/audio/convert", {}));

		expect(response.status).toBe(400);
		const data = await response.json();
		expect(data.code).toBe("INVALID_REQUEST");
	});

	test("returns audio stream when conversion succeeds", async () => {
		const mockAudioData = new Uint8Array([0x49, 0x44, 0x33]);

		mock.module("../../lib/ffmpeg", () => ({
			canAcceptNewProcess: ffmpeg.canAcceptNewProcess,
			checkHasAudioTrack: ffmpeg.checkHasAudioTrack,
			extractAudio: ffmpeg.extractAudio,
			extractAudioStream: () => ({
				stream: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(mockAudioData);
						controller.close();
					},
				}),
				cleanup: () => {},
			}),
			getActiveProcessCount: ffmpeg.getActiveProcessCount,
		}));

		const { default: appWithMock } = await import("../../app");

		const response = await appWithMock.fetch(
			audioPostRequest("/audio/convert", {
				audioUrl: "https://example.com/audio.wav",
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("audio/mpeg");

		const buffer = await response.arrayBuffer();
		expect(new Uint8Array(buffer)).toEqual(mockAudioData);
	});
});
