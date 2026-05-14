import { writeFile } from "node:fs/promises";
import { file, spawn } from "bun";
import type { VideoMetadata } from "./job-manager";
import { registerSubprocess, terminateProcess } from "./subprocess";
import { createTempFile, type TempFileHandle } from "./temp-files";

export type EditRange = {
	start: number;
	end: number;
};

type ProgressCallback = (progress: number, message: string) => void;

type RenderEditedVideoInput = {
	inputPath: string;
	keepRanges: EditRange[];
	metadata: VideoMetadata;
	onProgress?: ProgressCallback;
	abortSignal?: AbortSignal;
};

const MIN_RANGE_DURATION = 0.05;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_OUTPUT_FPS = 30;

function roundTime(value: number) {
	return Math.round(value * 1000) / 1000;
}

function getRangeDuration(range: EditRange) {
	return Math.max(0, range.end - range.start);
}

function getTotalRangeDuration(ranges: EditRange[]) {
	return ranges.reduce((total, range) => total + getRangeDuration(range), 0);
}

function getTimeoutMs(ranges: EditRange[]) {
	const durationMs = getTotalRangeDuration(ranges) * 20_000;
	return Math.min(MAX_TIMEOUT_MS, Math.max(DEFAULT_TIMEOUT_MS, durationMs));
}

export function normalizeEditRanges(
	ranges: EditRange[],
	sourceDuration: number,
) {
	const duration =
		Number.isFinite(sourceDuration) && sourceDuration > 0
			? roundTime(sourceDuration)
			: 0;

	const sortedRanges = ranges
		.map((range) => {
			const start = Number.isFinite(range.start) ? range.start : 0;
			const end = Number.isFinite(range.end) ? range.end : 0;
			return {
				start: roundTime(Math.min(Math.max(0, start), duration)),
				end: roundTime(Math.min(Math.max(0, end), duration)),
			};
		})
		.filter((range) => range.end - range.start >= MIN_RANGE_DURATION)
		.sort((a, b) => a.start - b.start || a.end - b.end);

	const mergedRanges: EditRange[] = [];
	for (const range of sortedRanges) {
		const previous = mergedRanges.at(-1);
		if (previous && range.start <= previous.end + MIN_RANGE_DURATION) {
			previous.end = Math.max(previous.end, range.end);
			continue;
		}
		mergedRanges.push({ ...range });
	}

	return mergedRanges;
}

function formatTime(value: number) {
	return roundTime(value).toFixed(3);
}

function getOutputFps(fps: number | undefined) {
	return Number.isFinite(fps) && fps && fps > 0
		? Math.min(120, Math.max(1, Math.round(fps * 100) / 100))
		: DEFAULT_OUTPUT_FPS;
}

export function buildStreamCopySegmentArgs(
	inputPath: string,
	range: EditRange,
	outputPath: string,
) {
	return [
		"ffmpeg",
		"-hide_banner",
		"-y",
		"-ss",
		formatTime(range.start),
		"-i",
		inputPath,
		"-t",
		formatTime(getRangeDuration(range)),
		"-map",
		"0",
		"-c",
		"copy",
		"-avoid_negative_ts",
		"make_zero",
		outputPath,
	];
}

export function buildTranscodeSegmentArgs(
	inputPath: string,
	range: EditRange,
	outputPath: string,
	hasAudio: boolean,
	fps = DEFAULT_OUTPUT_FPS,
) {
	const videoFilter = `fps=${getOutputFps(fps)},trim=start=${formatTime(range.start)}:end=${formatTime(range.end)},setpts=PTS-STARTPTS`;
	const filterComplex = hasAudio
		? `[0:v:0]${videoFilter}[v];[0:a:0]atrim=start=${formatTime(range.start)}:end=${formatTime(range.end)},asetpts=PTS-STARTPTS[a]`
		: `[0:v:0]${videoFilter}[v]`;

	return [
		"ffmpeg",
		"-hide_banner",
		"-y",
		"-i",
		inputPath,
		"-filter_complex",
		filterComplex,
		"-map",
		"[v]",
		"-c:v",
		"libx264",
		"-preset",
		"fast",
		"-crf",
		"18",
		"-pix_fmt",
		"yuv420p",
		...(hasAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "160k"] : ["-an"]),
		"-movflags",
		"+faststart",
		outputPath,
	];
}

function buildConcatArgs(listPath: string, outputPath: string) {
	return [
		"ffmpeg",
		"-hide_banner",
		"-y",
		"-f",
		"concat",
		"-safe",
		"0",
		"-i",
		listPath,
		"-map",
		"0",
		"-c",
		"copy",
		"-movflags",
		"+faststart",
		outputPath,
	];
}

async function drainStream(stream: ReadableStream<Uint8Array> | null) {
	if (!stream) return;
	const reader = stream.getReader();
	try {
		while (true) {
			const { done } = await reader.read();
			if (done) break;
		}
	} finally {
		reader.releaseLock();
	}
}

async function readStream(stream: ReadableStream<Uint8Array> | null) {
	if (!stream) return "";
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	cleanup: () => Promise<void>,
) {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let cleanupPromise: Promise<void> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			cleanupPromise = cleanup();
			reject(new Error(`Operation timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});

	try {
		const result = await Promise.race([promise, timeoutPromise]);
		if (timeoutId) clearTimeout(timeoutId);
		return result;
	} catch (error) {
		if (cleanupPromise) {
			await cleanupPromise;
		}
		if (timeoutId) clearTimeout(timeoutId);
		throw error;
	}
}

async function runFfmpegCommand(
	args: string[],
	timeoutMs: number,
	abortSignal?: AbortSignal,
) {
	const proc = registerSubprocess(
		spawn({
			cmd: args,
			stdout: "pipe",
			stderr: "pipe",
		}),
	);

	let abortCleanup: (() => void) | undefined;
	if (abortSignal) {
		abortCleanup = () => {
			void terminateProcess(proc);
		};
		abortSignal.addEventListener("abort", abortCleanup, { once: true });
	}

	try {
		await withTimeout(
			(async () => {
				const [stderrText, exitCode] = await Promise.all([
					readStream(proc.stderr as ReadableStream<Uint8Array>),
					drainStream(proc.stdout as ReadableStream<Uint8Array>).then(
						() => proc.exited,
					),
				]);

				if (exitCode !== 0) {
					throw new Error(
						`FFmpeg exited with code ${exitCode}. Last stderr: ${stderrText.slice(-2000)}`,
					);
				}
			})(),
			timeoutMs,
			() => terminateProcess(proc),
		);
	} finally {
		if (abortCleanup) {
			abortSignal?.removeEventListener("abort", abortCleanup);
		}
		await terminateProcess(proc);
	}
}

function concatFileLine(path: string) {
	return `file '${path.replaceAll("'", "'\\''")}'`;
}

async function concatSegments(
	segmentFiles: TempFileHandle[],
	timeoutMs: number,
	abortSignal?: AbortSignal,
) {
	const concatList = await createTempFile(".txt");
	const outputFile = await createTempFile(".mp4");

	try {
		await writeFile(
			concatList.path,
			`${segmentFiles.map((segment) => concatFileLine(segment.path)).join("\n")}\n`,
		);
		await runFfmpegCommand(
			buildConcatArgs(concatList.path, outputFile.path),
			timeoutMs,
			abortSignal,
		);

		const outputSize = await file(outputFile.path).size;
		if (outputSize === 0) {
			throw new Error("FFmpeg produced empty edited output");
		}

		return outputFile;
	} catch (error) {
		await outputFile.cleanup();
		throw error;
	} finally {
		await concatList.cleanup();
	}
}

async function renderSegments({
	keepRanges,
	timeoutMs,
	buildArgs,
	onProgress,
	abortSignal,
	progressStart,
	progressEnd,
}: {
	keepRanges: EditRange[];
	timeoutMs: number;
	buildArgs: (range: EditRange, outputPath: string) => string[];
	onProgress?: ProgressCallback;
	abortSignal?: AbortSignal;
	progressStart: number;
	progressEnd: number;
}) {
	const segmentFiles: TempFileHandle[] = [];

	try {
		for (const [index, range] of keepRanges.entries()) {
			const segmentFile = await createTempFile(".mp4");
			segmentFiles.push(segmentFile);
			await runFfmpegCommand(
				buildArgs(range, segmentFile.path),
				timeoutMs,
				abortSignal,
			);
			const progress =
				progressStart +
				((index + 1) / keepRanges.length) * (progressEnd - progressStart);
			onProgress?.(progress, "Preparing edit...");
		}

		const outputFile = await concatSegments(
			segmentFiles,
			timeoutMs,
			abortSignal,
		);
		onProgress?.(progressEnd, "Edit prepared");
		return outputFile;
	} finally {
		await Promise.all(segmentFiles.map((segment) => segment.cleanup()));
	}
}

export async function renderEditedVideo({
	inputPath,
	keepRanges,
	metadata,
	onProgress,
	abortSignal,
}: RenderEditedVideoInput) {
	const normalizedRanges = normalizeEditRanges(keepRanges, metadata.duration);
	if (normalizedRanges.length === 0) {
		throw new Error("Edit must keep at least one range");
	}

	const timeoutMs = getTimeoutMs(normalizedRanges);

	return await renderSegments({
		keepRanges: normalizedRanges,
		timeoutMs,
		buildArgs: (range, outputPath) =>
			buildTranscodeSegmentArgs(
				inputPath,
				range,
				outputPath,
				Boolean(metadata.audioCodec),
				metadata.fps,
			),
		onProgress,
		abortSignal,
		progressStart: 5,
		progressEnd: 75,
	});
}
