import { resolve } from "node:path";
import {
	computeRenderSpec,
	normalizeConfigForRender,
} from "@cap/editor-render-spec";
import { spawn } from "bun";
import {
	buildAudioTimelineFilterGraph,
	buildVideoTimelineFilterGraph,
	fetchWithLoopbackBridge,
	formatFfmpegNumber,
	normalizeTimelineSegments,
	type ProgressCallback,
	resolveBackgroundImagePath,
	type TimelineSegment,
	type VideoProcessingOptions,
} from "./ffmpeg-video";
import { probeVideo } from "./ffprobe";
import type { VideoMetadata } from "./job-manager";
import { createTempFile, type TempFileHandle } from "./temp-files";

const PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const PROGRESS_STALL_TIMEOUT_MS = 180_000;
const PROGRESS_STALL_NEAR_COMPLETE_TIMEOUT_MS = 60_000;

const DEFAULT_OPTIONS: Required<VideoProcessingOptions> = {
	maxWidth: 1920,
	maxHeight: 1080,
	videoBitrate: "5M",
	audioBitrate: "128k",
	crf: 23,
	preset: "medium",
	remuxOnly: false,
};

const COMPOSITOR_WORKER_PATH = resolve(import.meta.dir, "compositor-worker.ts");

function killProcess(proc: { kill(): void }): void {
	try {
		proc.kill();
	} catch {}
}

interface BunFileSink {
	write(data: Uint8Array): number;
	end(): void;
	flush(): void | Promise<void>;
}

async function pumpToFileSink(
	source: ReadableStream<Uint8Array>,
	sink: BunFileSink,
): Promise<void> {
	const reader = source.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			sink.write(value);
		}
	} finally {
		reader.releaseLock();
		try {
			await sink.flush();
			sink.end();
		} catch {}
	}
}

function parseProgressFromStderr(
	stderrLine: string,
	totalDurationUs: number,
): number | null {
	if (totalDurationUs <= 0) {
		return null;
	}

	const outTimeUsMatch = stderrLine.match(/out_time_us=(\d+)/);
	if (outTimeUsMatch) {
		const currentUs = Number.parseInt(outTimeUsMatch[1] ?? "0", 10);
		return Math.min(100, (currentUs / totalDurationUs) * 100);
	}

	const outTimeMsMatch = stderrLine.match(/out_time_ms=(\d+)/);
	if (outTimeMsMatch) {
		const currentUs = Number.parseInt(outTimeMsMatch[1] ?? "0", 10);
		return Math.min(100, (currentUs / totalDurationUs) * 100);
	}

	const outTimeMatch = stderrLine.match(
		/out_time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/,
	);
	if (!outTimeMatch) {
		return null;
	}

	const hours = Number.parseInt(outTimeMatch[1] ?? "0", 10);
	const minutes = Number.parseInt(outTimeMatch[2] ?? "0", 10);
	const seconds = Number.parseFloat(outTimeMatch[3] ?? "0");
	if (
		!Number.isFinite(hours) ||
		!Number.isFinite(minutes) ||
		!Number.isFinite(seconds)
	) {
		return null;
	}

	const currentUs = Math.round(
		(hours * 3600 + minutes * 60 + seconds) * 1_000_000,
	);
	return Math.min(100, (currentUs / totalDurationUs) * 100);
}

async function collectStderr(
	stream: ReadableStream<Uint8Array>,
): Promise<string> {
	const reader = stream.getReader();
	const chunks: string[] = [];
	const decoder = new TextDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(decoder.decode(value, { stream: true }));
		}
	} finally {
		reader.releaseLock();
	}
	return chunks.join("");
}

function toEven(n: number): number {
	const rounded = Math.round(n);
	return rounded % 2 === 0 ? rounded : rounded + 1;
}

export async function processVideoWithCanvasPipeline(
	inputPath: string,
	metadata: VideoMetadata,
	segments: ReadonlyArray<TimelineSegment>,
	projectConfig: unknown,
	options: VideoProcessingOptions = {},
	onProgress?: ProgressCallback,
	abortSignal?: AbortSignal,
	cameraInputPath?: string,
): Promise<TempFileHandle> {
	const definedOptions = Object.fromEntries(
		Object.entries(options).filter(([, v]) => v !== undefined),
	) as VideoProcessingOptions;
	const opts = { ...DEFAULT_OPTIONS, ...definedOptions };

	const normalizedSegments = normalizeTimelineSegments(
		segments,
		metadata.duration,
	);
	const hasAudio = Boolean(metadata.audioCodec);

	const { filterGraph: videoFilterGraph, totalDuration } =
		buildVideoTimelineFilterGraph(normalizedSegments);
	const targetDuration = Math.max(totalDuration, 0.1);

	const normalized = normalizeConfigForRender(projectConfig);
	const renderSpec = computeRenderSpec(
		normalized.config,
		metadata.width,
		metadata.height,
	);

	let backgroundImagePath: string | null = null;
	const bg = normalized.config.background.source;
	if ((bg.type === "image" || bg.type === "wallpaper") && bg.path) {
		backgroundImagePath = resolveBackgroundImagePath(bg.path);
	}

	let bgImageTempFile: TempFileHandle | null = null;
	if (
		backgroundImagePath &&
		(backgroundImagePath.startsWith("http://") ||
			backgroundImagePath.startsWith("https://"))
	) {
		try {
			const ext =
				backgroundImagePath.match(/\.(jpe?g|png|webp|bmp)/i)?.[0] ?? ".jpg";
			bgImageTempFile = await createTempFile(ext);
			const imgResponse = await fetchWithLoopbackBridge(backgroundImagePath, {
				signal: abortSignal ?? AbortSignal.timeout(60_000),
			});
			if (!imgResponse.ok) {
				throw new Error(`HTTP ${imgResponse.status}`);
			}
			const imgData = await imgResponse.arrayBuffer();
			await Bun.write(bgImageTempFile.path, imgData);
			backgroundImagePath = bgImageTempFile.path;
		} catch (err) {
			console.error(
				"[canvasPipeline] Failed to download background image:",
				err,
			);
			await bgImageTempFile?.cleanup();
			bgImageTempFile = null;
			backgroundImagePath = null;
		}
	}

	let cameraConfig: { width: number; height: number } | null = null;
	if (cameraInputPath && renderSpec.cameraSpec) {
		try {
			const cameraMeta = await probeVideo(cameraInputPath);
			if (cameraMeta.width <= 0 || cameraMeta.height <= 0) {
				throw new Error(
					`Invalid camera dimensions: ${cameraMeta.width}x${cameraMeta.height}`,
				);
			}
			const camScaleW = metadata.width;
			const camScaleH = toEven(
				(metadata.width * cameraMeta.height) / cameraMeta.width,
			);
			cameraConfig = { width: camScaleW, height: camScaleH };
		} catch (err) {
			console.error(
				"[canvasPipeline] Failed to probe camera, rendering without camera:",
				err,
			);
			cameraInputPath = undefined;
		}
	}

	const configTempFile = await createTempFile(".json");
	await Bun.write(
		configTempFile.path,
		JSON.stringify({
			sourceWidth: metadata.width,
			sourceHeight: metadata.height,
			renderSpec,
			backgroundImagePath,
			camera: cameraConfig,
		}),
	);

	const outputTempFile = await createTempFile(".mp4");

	let decoderArgs: string[];
	if (cameraInputPath && cameraConfig) {
		const camScaleFilter = `[1:v]fps=${formatFfmpegNumber(metadata.fps)},scale=${cameraConfig.width}:${cameraConfig.height},format=rgba[camrgba]`;
		const vstackFilter = `${videoFilterGraph};[vout]format=rgba[disprgba];${camScaleFilter};[disprgba][camrgba]vstack=inputs=2[stacked]`;
		decoderArgs = [
			"ffmpeg",
			"-threads",
			"2",
			"-i",
			inputPath,
			"-i",
			cameraInputPath,
			"-filter_complex",
			vstackFilter,
			"-map",
			"[stacked]",
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgba",
			"pipe:1",
		];
	} else {
		decoderArgs = [
			"ffmpeg",
			"-threads",
			"2",
			"-i",
			inputPath,
			"-filter_complex",
			`${videoFilterGraph};[vout]format=rgba[rgbaout]`,
			"-map",
			"[rgbaout]",
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgba",
			"pipe:1",
		];
	}

	const encoderArgs = [
		"ffmpeg",
		"-threads",
		"2",
		"-f",
		"rawvideo",
		"-pix_fmt",
		"rgba",
		"-s",
		`${renderSpec.outputWidth}x${renderSpec.outputHeight}`,
		"-r",
		formatFfmpegNumber(metadata.fps),
		"-i",
		"pipe:0",
	];

	if (hasAudio) {
		encoderArgs.push("-i", inputPath);
		const audioFilterGraph = buildAudioTimelineFilterGraph(
			normalizedSegments,
			1,
		);
		encoderArgs.push("-filter_complex", audioFilterGraph);
		encoderArgs.push("-map", "0:v", "-map", "[aout]");
	} else {
		encoderArgs.push("-map", "0:v");
		encoderArgs.push("-an");
	}

	encoderArgs.push(
		"-c:v",
		"libx264",
		"-preset",
		opts.preset,
		"-crf",
		opts.crf.toString(),
	);

	if (hasAudio) {
		encoderArgs.push("-c:a", "aac", "-b:a", opts.audioBitrate);
	}

	encoderArgs.push(
		"-movflags",
		"+faststart",
		"-t",
		formatFfmpegNumber(targetDuration),
		"-progress",
		"pipe:2",
		"-y",
		outputTempFile.path,
	);

	console.log(`[canvasPipeline] Decoder: ${decoderArgs.join(" ")}`);
	console.log(`[canvasPipeline] Encoder: ${encoderArgs.join(" ")}`);

	const decoder = spawn({
		cmd: decoderArgs,
		stdout: "pipe",
		stderr: "pipe",
	});

	const compositor = spawn({
		cmd: ["bun", "run", COMPOSITOR_WORKER_PATH, configTempFile.path],
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	const encoder = spawn({
		cmd: encoderArgs,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	const allProcs = [decoder, compositor, encoder];

	let abortCleanup: (() => void) | undefined;
	if (abortSignal) {
		if (abortSignal.aborted) {
			for (const proc of allProcs) {
				killProcess(proc);
			}
			await outputTempFile.cleanup();
			await configTempFile.cleanup();
			await bgImageTempFile?.cleanup();
			throw new Error("Aborted before pipeline started");
		}
		abortCleanup = () => {
			for (const proc of allProcs) {
				killProcess(proc);
			}
		};
		abortSignal.addEventListener("abort", abortCleanup, { once: true });
	}

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let progressStalled = false;

	const scheduleWatchdog = (timeoutMs: number) => {
		if (timeoutId) clearTimeout(timeoutId);
		timeoutId = setTimeout(() => {
			progressStalled = true;
			for (const proc of allProcs) {
				killProcess(proc);
			}
		}, timeoutMs);
	};

	scheduleWatchdog(PROGRESS_STALL_TIMEOUT_MS);

	try {
		const compositorStderrPromise = collectStderr(
			compositor.stderr as ReadableStream<Uint8Array>,
		);

		const totalDurationUs = targetDuration * 1_000_000;
		const stderrLines: string[] = [];
		const MAX_STDERR_LINES = 50;
		let reachedNearComplete = false;

		const pipelinePromise = Promise.all([
			pumpToFileSink(
				decoder.stdout as ReadableStream<Uint8Array>,
				compositor.stdin as unknown as BunFileSink,
			),
			pumpToFileSink(
				compositor.stdout as ReadableStream<Uint8Array>,
				encoder.stdin as unknown as BunFileSink,
			),
			(async () => {
				const stderrReader = (
					encoder.stderr as ReadableStream<Uint8Array>
				).getReader();
				const textDecoder = new TextDecoder();
				let stderrBuffer = "";

				try {
					while (true) {
						const { done, value } = await stderrReader.read();
						if (done) break;

						stderrBuffer += textDecoder.decode(value, { stream: true });
						const lines = stderrBuffer.split("\n");
						stderrBuffer = lines.pop() ?? "";

						for (const line of lines) {
							stderrLines.push(line);
							if (stderrLines.length > MAX_STDERR_LINES) {
								stderrLines.shift();
							}
							const progress = parseProgressFromStderr(line, totalDurationUs);
							if (progress !== null && progress >= 98) {
								reachedNearComplete = true;
							}
							const timeoutMs = reachedNearComplete
								? PROGRESS_STALL_NEAR_COMPLETE_TIMEOUT_MS
								: PROGRESS_STALL_TIMEOUT_MS;
							scheduleWatchdog(timeoutMs);
							if (progress !== null && onProgress) {
								onProgress(progress, `Encoding: ${Math.round(progress)}%`);
							}
						}
					}
				} finally {
					stderrReader.releaseLock();
				}
			})(),
		]);

		const decoderStderrPromise = collectStderr(
			decoder.stderr as ReadableStream<Uint8Array>,
		);

		await Promise.race([
			pipelinePromise,
			new Promise<never>((_, reject) => {
				setTimeout(() => {
					for (const proc of allProcs) {
						killProcess(proc);
					}
					reject(
						new Error(
							`Canvas pipeline timed out after ${PROCESS_TIMEOUT_MS}ms`,
						),
					);
				}, PROCESS_TIMEOUT_MS);
			}),
		]);

		const [decoderExit, compositorExit, encoderExit] = await Promise.all([
			decoder.exited,
			compositor.exited,
			encoder.exited,
		]);

		if (decoderExit !== 0) {
			const decoderStderr = await decoderStderrPromise;
			throw new Error(
				`Decoder FFmpeg exited with code ${decoderExit}. stderr: ${decoderStderr.slice(-500)}`,
			);
		}

		if (compositorExit !== 0) {
			const compositorStderr = await compositorStderrPromise;
			throw new Error(
				`Compositor exited with code ${compositorExit}. stderr: ${compositorStderr.slice(-500)}`,
			);
		}

		if (encoderExit !== 0) {
			if (progressStalled) {
				throw new Error(
					`Encoder progress stalled for ${PROGRESS_STALL_TIMEOUT_MS}ms`,
				);
			}
			throw new Error(
				`Encoder FFmpeg exited with code ${encoderExit}. Last stderr: ${stderrLines.slice(-10).join(" | ")}`,
			);
		}

		const outputFile = Bun.file(outputTempFile.path);
		const outputSize = outputFile.size;
		if (outputSize === 0) {
			throw new Error("Canvas pipeline produced empty output file");
		}

		return outputTempFile;
	} catch (err) {
		await outputTempFile.cleanup();
		throw err;
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		if (abortCleanup) {
			abortSignal?.removeEventListener("abort", abortCleanup);
		}
		for (const proc of allProcs) {
			killProcess(proc);
		}
		await configTempFile.cleanup();
		await bgImageTempFile?.cleanup();
	}
}
