import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const local = vi.hoisted(() => ({
	probedSeconds: null as number | null,
	extract: vi.fn(),
	cleanup: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	NODE_ENV: "test",
}));

vi.mock("@/lib/audio-extract", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/audio-extract")>()),
	probeMediaDurationSeconds: async () => local.probedSeconds,
	extractAudioFromUrl: local.extract,
}));

import {
	audioExtractionArgs,
	parseFfmpegDurationSeconds,
} from "@/lib/audio-extract";
import {
	extractTranscriptAudioBytes,
	TRANSCRIPT_AUDIO_ENCODER_STOP_BYTES,
	TRANSCRIPT_AUDIO_ENCODER_STOP_SECONDS,
	TRANSCRIPT_AUDIO_MAX_BYTES,
	TRANSCRIPT_AUDIO_MAX_SECONDS,
} from "@/lib/developer-transcript-audio";
import {
	limitStreamBytes,
	PublicMediaFetchError,
	readStreamBounded,
	StreamTooLargeError,
} from "@/lib/public-media-fetch";

const endless = (chunkBytes: number) => {
	const state = { pulled: 0, cancelled: false };
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			state.pulled += chunkBytes;
			controller.enqueue(new Uint8Array(chunkBytes));
		},
		cancel() {
			state.cancelled = true;
		},
	});
	return { stream, state };
};

const finite = (bytes: number, chunkBytes = 1000) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			for (let sent = 0; sent < bytes; sent += chunkBytes) {
				controller.enqueue(
					new Uint8Array(Math.min(chunkBytes, bytes - sent)).fill(7),
				);
			}
			controller.close();
		},
	});

describe("readStreamBounded", () => {
	it("returns a stream that fits", async () => {
		const buffer = await readStreamBounded(finite(10_000), 10_000);
		expect(buffer.length).toBe(10_000);
		expect(buffer.every((byte) => byte === 7)).toBe(true);
	});

	it("stops reading an endless stream at the cap and cancels its source", async () => {
		const { stream, state } = endless(4096);
		await expect(readStreamBounded(stream, 100_000)).rejects.toBeInstanceOf(
			StreamTooLargeError,
		);
		expect(state.cancelled).toBe(true);
		expect(state.pulled).toBeGreaterThan(100_000);
		expect(state.pulled).toBeLessThanOrEqual(100_000 + 8 * 4096);
	});

	it("rejects a stream one byte over the cap", async () => {
		await expect(
			readStreamBounded(finite(10_001), 10_000),
		).rejects.toMatchObject({ name: "StreamTooLargeError", maxBytes: 10_000 });
	});

	it("keeps the download error for URL sources by default", async () => {
		const reader = limitStreamBytes(finite(2000), 1000).getReader();
		await expect(
			(async () => {
				for (;;) if ((await reader.read()).done) break;
			})(),
		).rejects.toBeInstanceOf(PublicMediaFetchError);
	});
});

describe("audio extraction limits", () => {
	it("caps four hours of 128 kbps audio with a small margin", () => {
		expect(TRANSCRIPT_AUDIO_MAX_SECONDS).toBe(4 * 3600 + 1);
		expect(TRANSCRIPT_AUDIO_ENCODER_STOP_SECONDS).toBe(4 * 3600 + 5);
		expect(TRANSCRIPT_AUDIO_MAX_BYTES).toBe((4 * 3600 + 2) * 16_000);
		expect(TRANSCRIPT_AUDIO_MAX_BYTES).toBeLessThan(
			TRANSCRIPT_AUDIO_ENCODER_STOP_SECONDS * 16_000,
		);
		expect(TRANSCRIPT_AUDIO_ENCODER_STOP_BYTES).toBe(
			TRANSCRIPT_AUDIO_MAX_BYTES + 65_536,
		);
	});

	it("only limits ffmpeg when asked", () => {
		const plain = audioExtractionArgs("https://s/a", "/tmp/out.mp3");
		expect(plain).not.toContain("-t");
		expect(plain).not.toContain("-fs");
		expect(plain.slice(-4)).toEqual(["-f", "mp3", "-y", "/tmp/out.mp3"]);

		const limited = audioExtractionArgs("https://s/a", "/tmp/out.mp3", {
			maxDurationSeconds: 14_405,
			maxBytes: 1_000,
		});
		expect(
			limited.slice(limited.indexOf("-t"), limited.indexOf("-t") + 4),
		).toEqual(["-t", "14405", "-fs", "1000"]);
		expect(limited.indexOf("-t")).toBeGreaterThan(limited.indexOf("-i"));
		expect(limited.at(-1)).toBe("/tmp/out.mp3");
	});

	it("reads the duration ffmpeg reports", () => {
		expect(
			parseFfmpegDurationSeconds(
				"Input #0, mov\n  Duration: 04:30:00.50, start: 0.000000, bitrate: 8 kb/s",
			),
		).toBe(16_200.5);
		expect(parseFfmpegDurationSeconds("  Duration: 00:00:13.14,")).toBe(13.14);
		expect(
			parseFfmpegDurationSeconds("  Duration: N/A, bitrate: N/A"),
		).toBeNull();
		expect(parseFfmpegDurationSeconds("no input")).toBeNull();
		expect(parseFfmpegDurationSeconds("  Duration: 00:00:00.00,")).toBeNull();
	});
});

describe("local extraction", () => {
	const makeFile = async (bytes: number) => {
		const path = join(tmpdir(), `transcript-audio-test-${crypto.randomUUID()}`);
		const handle = await fs.open(path, "w");
		await handle.truncate(bytes);
		await handle.close();
		return path;
	};

	beforeEach(() => {
		local.probedSeconds = null;
		local.extract.mockReset();
		local.cleanup.mockReset();
	});

	it("refuses a source that reports more than the limit without extracting", async () => {
		local.probedSeconds = 4.5 * 3600;
		expect(await extractTranscriptAudioBytes("https://s/a")).toEqual({
			state: "too_long",
		});
		expect(local.extract).not.toHaveBeenCalled();
	});

	it("tells ffmpeg where to stop and returns audio within the cap", async () => {
		const path = await makeFile(2048);
		local.extract.mockResolvedValue({
			filePath: path,
			mimeType: "audio/mpeg",
			cleanup: async () => {
				local.cleanup();
				await fs.unlink(path);
			},
		});

		const result = await extractTranscriptAudioBytes("https://s/a");

		expect(result.state === "ok" && result.audio.length).toBe(2048);
		expect(local.extract).toHaveBeenCalledWith("https://s/a", {
			maxDurationSeconds: TRANSCRIPT_AUDIO_ENCODER_STOP_SECONDS,
			maxBytes: TRANSCRIPT_AUDIO_ENCODER_STOP_BYTES,
		});
		expect(local.cleanup).toHaveBeenCalledTimes(1);
	});

	it("never reads an extracted file that is over the cap", async () => {
		const path = await makeFile(TRANSCRIPT_AUDIO_MAX_BYTES + 1);
		const readFile = vi.spyOn(fs, "readFile");
		local.extract.mockResolvedValue({
			filePath: path,
			mimeType: "audio/mpeg",
			cleanup: async () => {
				local.cleanup();
				await fs.unlink(path);
			},
		});

		expect(await extractTranscriptAudioBytes("https://s/a")).toEqual({
			state: "too_long",
		});
		expect(readFile).not.toHaveBeenCalled();
		expect(local.cleanup).toHaveBeenCalledTimes(1);
		readFile.mockRestore();
	});

	it("reports a file with no audio stream", async () => {
		local.extract.mockRejectedValue(
			new Error(
				"Audio extraction failed with code 1: Output file does not contain any stream",
			),
		);
		expect(await extractTranscriptAudioBytes("https://s/a")).toEqual({
			state: "no_audio",
		});
	});

	it("lets other extraction failures surface so the job retries", async () => {
		local.extract.mockRejectedValue(new Error("Audio extraction failed: boom"));
		await expect(extractTranscriptAudioBytes("https://s/a")).rejects.toThrow(
			"boom",
		);
	});
});
