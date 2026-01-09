import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ffmpeg-static", () => ({
	default: "/usr/local/bin/ffmpeg",
}));

const mockUnlink = vi.fn(() => Promise.resolve(undefined));
vi.mock("node:fs", () => ({
	promises: {
		unlink: () => mockUnlink(),
	},
}));

class MockChildProcess extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
}

let mockProcess: MockChildProcess;
let spawnArgs: { command: string; args: string[] }[] = [];

vi.mock("node:child_process", () => ({
	spawn: (command: string, args: string[]) => {
		spawnArgs.push({ command, args });
		mockProcess = new MockChildProcess();
		return mockProcess;
	},
}));

describe("audio-extract", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		spawnArgs = [];
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe("checkHasAudioTrack", () => {
		it("returns true when video has audio stream", async () => {
			const { checkHasAudioTrack } = await import("@/lib/audio-extract");

			const resultPromise = checkHasAudioTrack("https://example.com/video.mp4");

			setTimeout(() => {
				mockProcess.stderr.emit(
					"data",
					Buffer.from(
						"Stream #0:0: Video: h264\n  Stream #0:1: Audio: aac, 44100 Hz",
					),
				);
				mockProcess.emit("close", 1);
			}, 10);

			const result = await resultPromise;
			expect(result).toBe(true);
		});

		it("returns false when video has no audio stream", async () => {
			const { checkHasAudioTrack } = await import("@/lib/audio-extract");

			const resultPromise = checkHasAudioTrack("https://example.com/video.mp4");

			setTimeout(() => {
				mockProcess.stderr.emit(
					"data",
					Buffer.from("Stream #0:0: Video: h264, 1920x1080"),
				);
				mockProcess.emit("close", 1);
			}, 10);

			const result = await resultPromise;
			expect(result).toBe(false);
		});

		it("returns false when ffmpeg errors", async () => {
			const { checkHasAudioTrack } = await import("@/lib/audio-extract");

			const resultPromise = checkHasAudioTrack("https://example.com/video.mp4");

			setTimeout(() => {
				mockProcess.emit("error", new Error("spawn failed"));
			}, 10);

			const result = await resultPromise;
			expect(result).toBe(false);
		});

		it("uses correct ffmpeg arguments", async () => {
			const { checkHasAudioTrack } = await import("@/lib/audio-extract");

			const resultPromise = checkHasAudioTrack("https://example.com/video.mp4");

			setTimeout(() => {
				mockProcess.stderr.emit("data", Buffer.from(""));
				mockProcess.emit("close", 1);
			}, 10);

			await resultPromise;

			const args = spawnArgs[0]?.args ?? [];
			expect(args).toContain("-i");
			expect(args).toContain("-hide_banner");
			expect(args).toContain("https://example.com/video.mp4");
		});
	});

	describe("extractAudioFromUrl", () => {
		it("uses correct ffmpeg arguments", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.emit("close", 0);
			}, 10);

			await resultPromise;

			const args = spawnArgs[0]?.args ?? [];
			expect(args).toContain("-i");
			expect(args).toContain("https://example.com/video.mp4");
			expect(args).toContain("-vn");
			expect(args).toContain("-acodec");
			expect(args).toContain("aac");
			expect(args).toContain("-b:a");
			expect(args).toContain("128k");
		});

		it("returns audio/mp4 mime type", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.emit("close", 0);
			}, 10);

			const result = await resultPromise;
			expect(result.mimeType).toBe("audio/mp4");
		});

		it("generates .m4a file in temp directory", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.emit("close", 0);
			}, 10);

			const result = await resultPromise;
			expect(result.filePath).toContain("audio-");
			expect(result.filePath).toContain(".m4a");
		});

		it("provides cleanup function", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.emit("close", 0);
			}, 10);

			const result = await resultPromise;
			expect(typeof result.cleanup).toBe("function");
			await result.cleanup();
			expect(mockUnlink).toHaveBeenCalled();
		});

		it("rejects on ffmpeg error", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.stderr.emit("data", Buffer.from("Conversion failed"));
				mockProcess.emit("close", 1);
			}, 10);

			await expect(resultPromise).rejects.toThrow("Audio extraction failed");
		});
	});

	describe("extractAudioToBuffer", () => {
		it("uses pipe output for streaming", async () => {
			const { extractAudioToBuffer } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioToBuffer(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.stdout.emit("data", Buffer.from("audio-data"));
				mockProcess.emit("close", 0);
			}, 10);

			await resultPromise;

			const args = spawnArgs[0]?.args ?? [];
			expect(args).toContain("-pipe:1");
		});

		it("returns Buffer instance", async () => {
			const { extractAudioToBuffer } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioToBuffer(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.stdout.emit("data", Buffer.from("test-audio"));
				mockProcess.emit("close", 0);
			}, 10);

			const result = await resultPromise;
			expect(Buffer.isBuffer(result)).toBe(true);
		});

		it("concatenates multiple chunks", async () => {
			const { extractAudioToBuffer } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioToBuffer(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.stdout.emit("data", Buffer.from("chunk1"));
				mockProcess.stdout.emit("data", Buffer.from("chunk2"));
				mockProcess.emit("close", 0);
			}, 10);

			const result = await resultPromise;
			expect(result.toString()).toBe("chunk1chunk2");
		});
	});
});
