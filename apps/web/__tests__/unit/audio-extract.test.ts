import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ffmpeg-installer/ffmpeg", () => ({
	path: "/usr/local/bin/ffmpeg",
}));

vi.mock("@ffprobe-installer/ffprobe", () => ({
	path: "/usr/local/bin/ffprobe",
}));

const mockUnlink = vi.fn().mockResolvedValue(undefined);
vi.mock("node:fs", () => ({
	promises: {
		unlink: mockUnlink,
	},
}));

let ffprobeData: { streams: Array<{ codec_type: string }> } = { streams: [] };
let ffprobeError: Error | null = null;

const mockChain = {
	noVideo: vi.fn(),
	audioCodec: vi.fn(),
	audioBitrate: vi.fn(),
	format: vi.fn(),
	outputOptions: vi.fn(),
	on: vi.fn(),
	save: vi.fn(),
	pipe: vi.fn(),
};

vi.mock("fluent-ffmpeg", () => {
	const createChain = () => {
		const eventHandlers: Record<string, (...args: unknown[]) => void> = {};

		mockChain.noVideo.mockImplementation(() => mockChain);
		mockChain.audioCodec.mockImplementation(() => mockChain);
		mockChain.audioBitrate.mockImplementation(() => mockChain);
		mockChain.format.mockImplementation(() => mockChain);
		mockChain.outputOptions.mockImplementation(() => mockChain);
		mockChain.on.mockImplementation(
			(event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers[event] = handler;
				return mockChain;
			},
		);
		mockChain.save.mockImplementation(() => {
			setTimeout(() => eventHandlers.end?.(), 10);
			return mockChain;
		});
		mockChain.pipe.mockImplementation(() => {
			const emitter = new EventEmitter();
			setTimeout(() => {
				emitter.emit("data", Buffer.from("test"));
				emitter.emit("end");
			}, 10);
			return emitter;
		});

		return mockChain;
	};

	const ffmpeg = vi.fn(() => createChain());

	(ffmpeg as Record<string, unknown>).setFfmpegPath = vi.fn();
	(ffmpeg as Record<string, unknown>).setFfprobePath = vi.fn();
	(ffmpeg as Record<string, unknown>).ffprobe = (
		_url: string,
		cb: (err: Error | null, data: unknown) => void,
	) => {
		setTimeout(() => cb(ffprobeError, ffprobeData), 10);
	};

	return { default: ffmpeg };
});

describe("audio-extract", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		ffprobeData = { streams: [{ codec_type: "audio" }] };
		ffprobeError = null;
	});

	describe("checkHasAudioTrack", () => {
		it("returns true when video has audio stream", async () => {
			ffprobeData = {
				streams: [{ codec_type: "video" }, { codec_type: "audio" }],
			};

			const { checkHasAudioTrack } = await import("@/lib/audio-extract");
			const result = await checkHasAudioTrack("https://example.com/video.mp4");

			expect(result).toBe(true);
		});

		it("returns false when video has no audio stream", async () => {
			ffprobeData = {
				streams: [{ codec_type: "video" }],
			};

			const { checkHasAudioTrack } = await import("@/lib/audio-extract");
			const result = await checkHasAudioTrack("https://example.com/video.mp4");

			expect(result).toBe(false);
		});

		it("returns false when ffprobe fails", async () => {
			ffprobeError = new Error("Failed to probe file");

			const { checkHasAudioTrack } = await import("@/lib/audio-extract");
			const result = await checkHasAudioTrack("https://example.com/video.mp4");

			expect(result).toBe(false);
		});

		it("returns false for empty streams array", async () => {
			ffprobeData = { streams: [] };

			const { checkHasAudioTrack } = await import("@/lib/audio-extract");
			const result = await checkHasAudioTrack("https://example.com/video.mp4");

			expect(result).toBe(false);
		});
	});

	describe("extractAudioFromUrl", () => {
		it("configures ffmpeg with correct audio settings", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			await extractAudioFromUrl("https://example.com/video.mp4");

			expect(mockChain.noVideo).toHaveBeenCalled();
			expect(mockChain.audioCodec).toHaveBeenCalledWith("aac");
			expect(mockChain.audioBitrate).toHaveBeenCalledWith("128k");
			expect(mockChain.format).toHaveBeenCalledWith("ipod");
		});

		it("sets faststart flag for streaming optimization", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			await extractAudioFromUrl("https://example.com/video.mp4");

			expect(mockChain.outputOptions).toHaveBeenCalledWith([
				"-movflags",
				"+faststart",
			]);
		});

		it("returns audio/mp4 mime type", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const result = await extractAudioFromUrl("https://example.com/video.mp4");

			expect(result.mimeType).toBe("audio/mp4");
		});

		it("generates .m4a file in temp directory", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const result = await extractAudioFromUrl("https://example.com/video.mp4");

			expect(result.filePath).toContain("audio-");
			expect(result.filePath).toContain(".m4a");
		});

		it("provides cleanup function", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const result = await extractAudioFromUrl("https://example.com/video.mp4");

			expect(typeof result.cleanup).toBe("function");
			await result.cleanup();
			expect(mockUnlink).toHaveBeenCalledWith(result.filePath);
		});
	});

	describe("extractAudioToBuffer", () => {
		it("uses fragmented MP4 output for streaming", async () => {
			const { extractAudioToBuffer } = await import("@/lib/audio-extract");

			await extractAudioToBuffer("https://example.com/video.mp4");

			expect(mockChain.outputOptions).toHaveBeenCalledWith([
				"-movflags",
				"+frag_keyframe+empty_moov",
			]);
		});

		it("returns Buffer instance", async () => {
			const { extractAudioToBuffer } = await import("@/lib/audio-extract");

			const result = await extractAudioToBuffer(
				"https://example.com/video.mp4",
			);

			expect(Buffer.isBuffer(result)).toBe(true);
		});

		it("uses pipe() for streaming output", async () => {
			const { extractAudioToBuffer } = await import("@/lib/audio-extract");

			await extractAudioToBuffer("https://example.com/video.mp4");

			expect(mockChain.pipe).toHaveBeenCalled();
		});
	});
});
