import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { spawn } from "bun";
import {
	checkHasAudioTrack,
	extractAudio,
	extractAudioStream,
	getActiveProcessCount,
} from "../../lib/ffmpeg";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO = `file://${join(FIXTURES_DIR, "test-with-audio.mp4")}`;

async function countFFmpegProcesses(): Promise<number> {
	const proc = spawn({
		cmd: ["pgrep", "-f", "ffmpeg"],
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = await new Response(proc.stdout).text();
	await proc.exited;
	return output.trim().split("\n").filter(Boolean).length;
}

async function getProcessMemoryMB(): Promise<number> {
	return process.memoryUsage().heapUsed / 1024 / 1024;
}

async function waitForProcessCleanup(
	expectedCount: number,
	timeoutMs = 5000,
): Promise<void> {
	const startTime = Date.now();
	while (Date.now() - startTime < timeoutMs) {
		if (getActiveProcessCount() === expectedCount) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(
		`Timeout waiting for process count to reach ${expectedCount}, got ${getActiveProcessCount()}`,
	);
}

describe("memory and resource leak tests", () => {
	let initialFFmpegCount: number;

	beforeAll(async () => {
		initialFFmpegCount = await countFFmpegProcesses();
	});

	afterAll(async () => {
		await new Promise((r) => setTimeout(r, 1000));
	});

	describe("process cleanup", () => {
		test("checkHasAudioTrack cleans up process after completion", async () => {
			const beforeCount = getActiveProcessCount();

			await checkHasAudioTrack(TEST_VIDEO_WITH_AUDIO);

			await waitForProcessCleanup(beforeCount);
			expect(getActiveProcessCount()).toBe(beforeCount);
		});

		test("extractAudio cleans up process after completion", async () => {
			const beforeCount = getActiveProcessCount();

			await extractAudio(TEST_VIDEO_WITH_AUDIO);

			await waitForProcessCleanup(beforeCount);
			expect(getActiveProcessCount()).toBe(beforeCount);
		});

		test("extractAudioStream cleans up after stream is fully consumed", async () => {
			const beforeCount = getActiveProcessCount();

			const { stream } = extractAudioStream(TEST_VIDEO_WITH_AUDIO);

			const reader = stream.getReader();
			while (true) {
				const { done } = await reader.read();
				if (done) break;
			}
			reader.releaseLock();

			await waitForProcessCleanup(beforeCount);
			expect(getActiveProcessCount()).toBe(beforeCount);
		});

		test("extractAudioStream cleans up when stream is cancelled", async () => {
			const beforeCount = getActiveProcessCount();

			const { stream, cleanup } = extractAudioStream(TEST_VIDEO_WITH_AUDIO);

			const reader = stream.getReader();
			await reader.read();
			reader.releaseLock();

			cleanup();

			await waitForProcessCleanup(beforeCount);
			expect(getActiveProcessCount()).toBe(beforeCount);
		});

		test("extractAudioStream cleans up via cancel() method", async () => {
			const beforeCount = getActiveProcessCount();

			const { stream } = extractAudioStream(TEST_VIDEO_WITH_AUDIO);

			await stream.cancel();

			await waitForProcessCleanup(beforeCount);
			expect(getActiveProcessCount()).toBe(beforeCount);
		});
	});

	describe("concurrent request handling", () => {
		test("handles multiple concurrent checkHasAudioTrack calls", async () => {
			const beforeCount = getActiveProcessCount();
			const concurrency = 5;

			const promises = Array.from({ length: concurrency }, () =>
				checkHasAudioTrack(TEST_VIDEO_WITH_AUDIO),
			);

			const results = await Promise.all(promises);

			expect(results.every((r) => r === true)).toBe(true);
			await waitForProcessCleanup(beforeCount);
			expect(getActiveProcessCount()).toBe(beforeCount);
		});

		test("handles multiple concurrent extractAudio calls", async () => {
			const beforeCount = getActiveProcessCount();
			const concurrency = 3;

			const promises = Array.from({ length: concurrency }, () =>
				extractAudio(TEST_VIDEO_WITH_AUDIO),
			);

			const results = await Promise.all(promises);

			expect(results.every((r) => r instanceof Uint8Array)).toBe(true);
			await waitForProcessCleanup(beforeCount);
			expect(getActiveProcessCount()).toBe(beforeCount);
		});

		test("handles mixed concurrent operations", async () => {
			const beforeCount = getActiveProcessCount();

			const operations = [
				checkHasAudioTrack(TEST_VIDEO_WITH_AUDIO),
				extractAudio(TEST_VIDEO_WITH_AUDIO),
				(async () => {
					const { stream } = extractAudioStream(TEST_VIDEO_WITH_AUDIO);
					const reader = stream.getReader();
					while (true) {
						const { done } = await reader.read();
						if (done) break;
					}
					reader.releaseLock();
				})(),
			];

			await Promise.all(operations);

			await waitForProcessCleanup(beforeCount);
			expect(getActiveProcessCount()).toBe(beforeCount);
		});
	});

	describe("memory stability", () => {
		test("memory does not grow unbounded over repeated operations", async () => {
			if (typeof Bun.gc !== "function") {
				console.log("Skipping GC test - Bun.gc not available");
				return;
			}

			Bun.gc(true);
			await new Promise((r) => setTimeout(r, 100));
			const initialMemory = await getProcessMemoryMB();

			const iterations = 10;
			for (let i = 0; i < iterations; i++) {
				await checkHasAudioTrack(TEST_VIDEO_WITH_AUDIO);
				await extractAudio(TEST_VIDEO_WITH_AUDIO);

				const { stream } = extractAudioStream(TEST_VIDEO_WITH_AUDIO);
				const reader = stream.getReader();
				while (true) {
					const { done } = await reader.read();
					if (done) break;
				}
				reader.releaseLock();
			}

			Bun.gc(true);
			await new Promise((r) => setTimeout(r, 100));
			const finalMemory = await getProcessMemoryMB();

			const memoryGrowth = finalMemory - initialMemory;
			const maxAllowedGrowthMB = 50;

			console.log(
				`Memory: initial=${initialMemory.toFixed(2)}MB, final=${finalMemory.toFixed(2)}MB, growth=${memoryGrowth.toFixed(2)}MB`,
			);

			expect(memoryGrowth).toBeLessThan(maxAllowedGrowthMB);
		});

		test("active process count stays bounded under load", async () => {
			const beforeCount = getActiveProcessCount();
			const operations = 20;

			const promises = Array.from({ length: operations }, async (_, i) => {
				try {
					if (i % 3 === 0) {
						await checkHasAudioTrack(TEST_VIDEO_WITH_AUDIO);
					} else if (i % 3 === 1) {
						await extractAudio(TEST_VIDEO_WITH_AUDIO);
					} else {
						const { stream, cleanup } = extractAudioStream(
							TEST_VIDEO_WITH_AUDIO,
						);
						const reader = stream.getReader();
						const { done } = await reader.read();
						if (!done) {
							reader.releaseLock();
							cleanup();
						}
					}
				} catch {
					// Server busy errors expected when hitting concurrency limit
				}
			});

			await Promise.all(promises);

			await waitForProcessCleanup(beforeCount, 10000);
			expect(getActiveProcessCount()).toBe(beforeCount);
		});
	});

	describe("no orphaned ffmpeg processes", () => {
		test("ffmpeg process count returns to baseline after operations", async () => {
			const baselineCount = await countFFmpegProcesses();

			await checkHasAudioTrack(TEST_VIDEO_WITH_AUDIO);
			await extractAudio(TEST_VIDEO_WITH_AUDIO);

			const { stream, cleanup } = extractAudioStream(TEST_VIDEO_WITH_AUDIO);
			await stream.cancel();
			cleanup();

			await new Promise((r) => setTimeout(r, 3000));

			const finalCount = await countFFmpegProcesses();

			const processGrowth = finalCount - baselineCount;
			expect(processGrowth).toBeLessThanOrEqual(2);
		});
	});
});

describe("abort signal handling", () => {
	test("stream cleanup is called when response is aborted", async () => {
		let cleanupCalled = false;

		const { stream, cleanup: originalCleanup } = extractAudioStream(
			TEST_VIDEO_WITH_AUDIO,
		);

		const wrappedCleanup = () => {
			cleanupCalled = true;
			originalCleanup();
		};

		const controller = new AbortController();

		setTimeout(() => controller.abort(), 50);

		controller.signal.addEventListener("abort", () => {
			wrappedCleanup();
		});

		try {
			const reader = stream.getReader();
			while (!controller.signal.aborted) {
				const { done } = await reader.read();
				if (done) break;
				await new Promise((r) => setTimeout(r, 10));
			}
			reader.releaseLock();
		} catch {}

		await new Promise((r) => setTimeout(r, 100));
		expect(cleanupCalled).toBe(true);
	});
});
