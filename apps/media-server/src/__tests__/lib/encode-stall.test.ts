import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ENCODE_STALL_MS,
	ENCODE_START_STALL_MS,
	watchEncodeProgress,
} from "../../lib/encode-stall";
import {
	EncodeStalledError,
	FfmpegExitError,
	isEncodeDeadlineError,
} from "../../lib/ffmpeg-errors";
import { PROCESS_TIMEOUT_MS, withTimeout } from "../../lib/media-common";
import { runFfmpegCommand as runEditCommand } from "../../lib/media-edit";
import { spawn } from "../../lib/media-spawn";
import {
	getProcessTimeoutMs,
	runTranscodeCommand,
} from "../../lib/media-video";
import { nvencFallbackReason } from "../../lib/nvenc-encoder";
import { getActiveSubprocessCount } from "../../lib/subprocess";

const WINDOWS = { startMs: 900, stallMs: 300, checkIntervalMs: 10 };

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "encode-stall-"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function settledWithin(
	watch: { stalled: Promise<never> },
	ms: number,
): Promise<unknown> {
	return Promise.race([
		watch.stalled.catch((error: unknown) => error),
		Bun.sleep(ms).then(() => "running"),
	]);
}

describe("watchEncodeProgress", () => {
	test("waits longer for the first frame than between frames", () => {
		expect(ENCODE_START_STALL_MS).toBe(10 * 60_000);
		expect(ENCODE_STALL_MS).toBe(5 * 60_000);
	});

	test("fails an encode that never produces a frame", async () => {
		const watch = watchEncodeProgress(join(dir, "never.mp4"), WINDOWS);
		try {
			watch.observe("out_time_us=N/A");
			watch.observe("frame=0");
			watch.observe("progress=continue");
			expect(await settledWithin(watch, 250)).toBe("running");
			const error = await settledWithin(watch, 2_000);
			expect(error).toBeInstanceOf(EncodeStalledError);
			expect((error as Error).message).toMatch(
				/^Encoding stalled: no progress for \d+ seconds$/,
			);
		} finally {
			watch.stop();
		}
	});

	test("fails sooner once frames have stopped coming", async () => {
		const watch = watchEncodeProgress(join(dir, "stops.mp4"), WINDOWS);
		try {
			watch.observe("out_time_us=1000000");
			const started = performance.now();
			const error = await settledWithin(watch, 1_000);
			expect(error).toBeInstanceOf(EncodeStalledError);
			expect(performance.now() - started).toBeLessThan(WINDOWS.startMs);
		} finally {
			watch.stop();
		}
	});

	test("repeated values are not progress, advancing ones are", async () => {
		const watch = watchEncodeProgress(join(dir, "steady.mp4"), WINDOWS);
		try {
			for (let step = 1; step <= 8; step++) {
				watch.observe(`out_time_us=${step * 1000}`);
				watch.observe("progress=continue");
				await Bun.sleep(50);
			}
			expect(await settledWithin(watch, 20)).toBe("running");
			for (let step = 0; step < 8; step++) {
				watch.observe("out_time_us=8000");
				watch.observe("frame=8");
				watch.observe("total_size=4096");
				await Bun.sleep(50);
			}
			expect(await settledWithin(watch, 500)).toBeInstanceOf(
				EncodeStalledError,
			);
		} finally {
			watch.stop();
		}
	});

	test("reads the status line FFmpeg prints without -progress", async () => {
		const watch = watchEncodeProgress(join(dir, "status.mp4"), WINDOWS);
		const status = (frame: number, size: number) =>
			`frame=${String(frame).padStart(5)} fps= 25 q=28.0 size=${String(size).padStart(8)}KiB time=00:00:01.00 bitrate= 100.0kbits/s dup_frames=9999 speed=1x    \r`;
		try {
			for (let step = 1; step <= 8; step++) {
				watch.observe(status(step * 10, step * 64));
				await Bun.sleep(50);
			}
			expect(await settledWithin(watch, 20)).toBe("running");
			for (let step = 0; step < 8; step++) {
				watch.observe(status(80, 512));
				await Bun.sleep(50);
			}
			expect(await settledWithin(watch, 500)).toBeInstanceOf(
				EncodeStalledError,
			);
		} finally {
			watch.stop();
		}
	});

	test("FFmpeg prints that status line when its output is a pipe", async () => {
		const proc = spawn({
			cmd: [
				"ffmpeg",
				"-hide_banner",
				"-f",
				"lavfi",
				"-i",
				"testsrc=size=64x64:rate=25:duration=1",
				"-f",
				"null",
				"-",
			],
			stdout: "ignore",
			stderr: "pipe",
		});
		const [stderr, code] = await Promise.all([
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code).toBe(0);
		expect(stderr).toMatch(/(?:^|\s)frame=\s*\d+/);
	});

	test("a file still being written is not stalled", async () => {
		const output = join(dir, "finishing.mp4");
		await writeFile(output, "moov");
		const watch = watchEncodeProgress(output, WINDOWS);
		try {
			watch.observe("out_time_us=5000000");
			for (let step = 0; step < 10; step++) {
				await appendFile(output, "mdat");
				await Bun.sleep(40);
			}
			expect(await settledWithin(watch, 20)).toBe("running");
			expect(await settledWithin(watch, 1_000)).toBeInstanceOf(
				EncodeStalledError,
			);
		} finally {
			watch.stop();
		}
	});

	test("stays quiet once stopped", async () => {
		const watch = watchEncodeProgress(join(dir, "stopped.mp4"), WINDOWS);
		watch.stop();
		expect(await settledWithin(watch, 1_200)).toBe("running");
	});
});

describe("runTranscodeCommand", () => {
	test("stops a process whose progress stops advancing, long before its deadline", async () => {
		const active = getActiveSubprocessCount();
		const stalledEncoder = [
			"bun",
			"-e",
			'process.stderr.write("frame=1\\nout_time_us=40000\\n"); setInterval(() => process.stderr.write("frame=1\\nout_time_us=40000\\nprogress=continue\\n"), 20);',
		];
		const started = performance.now();
		const error = await runTranscodeCommand(
			stalledEncoder,
			join(dir, "stalled.mp4"),
			10_000_000,
			60_000,
			undefined,
			undefined,
			WINDOWS,
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(EncodeStalledError);
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(getActiveSubprocessCount()).toBe(active);
	}, 20_000);

	test("still reports an encoder failure as itself", async () => {
		const error = await runTranscodeCommand(
			["bun", "-e", 'console.error("Invalid argument"); process.exit(3);'],
			join(dir, "failed.mp4"),
			10_000_000,
			60_000,
			undefined,
			undefined,
			WINDOWS,
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(FfmpegExitError);
		expect((error as Error).message).toContain("FFmpeg exited with code 3");
	}, 20_000);
});

describe("edit renders", () => {
	test("stop when FFmpeg's status line stops advancing", async () => {
		const active = getActiveSubprocessCount();
		const stalledEdit = [
			"bun",
			"-e",
			'const line = "frame=   12 fps= 25 q=28.0 size=      64KiB time=00:00:00.48 speed=1x    \\r"; process.stderr.write(line); setInterval(() => process.stderr.write(line), 20);',
			join(dir, "stalled-edit.mp4"),
		];
		const started = performance.now();
		const error = await runEditCommand(
			stalledEdit,
			60_000,
			undefined,
			WINDOWS,
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(EncodeStalledError);
		expect(nvencFallbackReason(error, false)).toBeNull();
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(getActiveSubprocessCount()).toBe(active);
	}, 20_000);

	test("still report an FFmpeg failure as itself", async () => {
		const error = await runEditCommand(
			["bun", "-e", 'console.error("Invalid argument"); process.exit(3);'],
			60_000,
			undefined,
			WINDOWS,
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(FfmpegExitError);
		expect((error as Error).message).toContain("FFmpeg exited with code 3");
	}, 20_000);
});

describe("encoder fallback", () => {
	test("a stall or a timeout is not retried on another encoder", async () => {
		const timedOut = await withTimeout(new Promise(() => {}), 5).catch(
			(caught: unknown) => caught,
		);
		expect(isEncodeDeadlineError(timedOut)).toBe(true);
		expect(nvencFallbackReason(timedOut, false)).toBeNull();
		expect(
			nvencFallbackReason(new EncodeStalledError(300_000), false),
		).toBeNull();
		expect(
			nvencFallbackReason(
				new FfmpegExitError("FFmpeg exited with code 1", []),
				false,
			),
		).toBe("FFmpeg exited with code 1");
		expect(isEncodeDeadlineError(new Error("connection timed out"))).toBe(
			false,
		);
	});
});

describe("getProcessTimeoutMs", () => {
	const minutes = (value: number) => value * 60_000;

	test("without a frame size the deadline is what it always was", () => {
		expect(getProcessTimeoutMs(5, PROCESS_TIMEOUT_MS)).toBe(minutes(45));
		expect(getProcessTimeoutMs(150, PROCESS_TIMEOUT_MS)).toBe(150 * 20_000);
		expect(getProcessTimeoutMs(3600, PROCESS_TIMEOUT_MS)).toBe(minutes(120));
		expect(getProcessTimeoutMs(0, PROCESS_TIMEOUT_MS)).toBe(minutes(45));
	});

	test("a short clip gets ten minutes plus time for its pixels", () => {
		expect(
			getProcessTimeoutMs(5, PROCESS_TIMEOUT_MS, { width: 1280, height: 720 }),
		).toBe(minutes(10) + 5 * 60 * 0.9216 * 500);
		expect(
			getProcessTimeoutMs(10, PROCESS_TIMEOUT_MS, {
				width: 1920,
				height: 1080,
			}),
		).toBe(minutes(10) + 10 * 60 * 2.0736 * 500);
	});

	test("never shorter than before for large frames, long videos or unknown sizes", () => {
		for (const [duration, frame] of [
			[5, { width: 7680, height: 4320 }],
			[10, { width: 3840, height: 2160 }],
			[60, { width: 1920, height: 1080 }],
			[150, { width: 1280, height: 720 }],
			[3600, { width: 1280, height: 720 }],
			[5, { width: 0, height: 0 }],
			[0, { width: 1280, height: 720 }],
			[Number.NaN, { width: 1280, height: 720 }],
		] as const) {
			expect(getProcessTimeoutMs(duration, PROCESS_TIMEOUT_MS, frame)).toBe(
				getProcessTimeoutMs(duration, PROCESS_TIMEOUT_MS),
			);
		}
	});

	test("never longer than the caller's own limit", () => {
		expect(
			getProcessTimeoutMs(5, minutes(2), { width: 1280, height: 720 }),
		).toBe(minutes(2));
	});
});
