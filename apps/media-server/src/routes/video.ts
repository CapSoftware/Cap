import { file } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import { validateMediaServerSecret } from "../lib/auth";
import type { VideoMetadata } from "../lib/job-manager";
import {
	canAcceptNewVideoProcess,
	createJob,
	deleteJob,
	forceCleanupActiveJobs,
	generateJobId,
	getActiveVideoProcessCount,
	getAllJobs,
	getJob,
	getJobProgress,
	getMaxConcurrentVideoProcesses,
	getSystemResources,
	hasCriticalMemoryPressure,
	sendWebhook,
	touchJob,
	updateJob,
} from "../lib/job-manager";
import { renderEditedVideo } from "../lib/media-edit";
import {
	canAcceptNewProbeOperation as canAcceptNewProbeProcess,
	getActiveProbeOperationCount as getActiveProbeProcessCount,
	probeVideo,
	probeVideoFile,
} from "../lib/media-probe";
import type {
	ResilientInputFlags,
	StorageUploadTarget,
} from "../lib/media-video";
import {
	abortStorageUploadTarget,
	downloadVideoToTemp,
	generatePreviewGif,
	generateThumbnail,
	muxMediaTracksToMp4,
	processVideo,
	repairContainer,
	uploadFileToS3,
	uploadFileToStorage,
	uploadToS3,
} from "../lib/media-video";
import type { TempFileHandle } from "../lib/temp-files";
import { cleanupStaleTempFiles } from "../lib/temp-files";
import {
	getActiveDirectVideoProcessCount,
	getMaxConcurrentDirectVideoProcesses,
	tryAcquireDirectVideoProcessSlot,
	type VideoProcessSlot,
} from "../lib/video-capacity";

const video = new Hono();
const PROCESSING_HEARTBEAT_MS = 60 * 1000;
const MEDIA_ENGINE_ERROR_CODE = ["FF", "MPEG_ERROR"].join("");
const PROBE_ERROR_CODE = ["FF", "PROBE_ERROR"].join("");
const VIDEO_BUSY_RETRY_AFTER_SECONDS = 15;
const VIDEO_MEMORY_PRESSURE_ERROR =
	"SERVER_BUSY: container memory pressure is too high";
const SEGMENT_DOWNLOAD_MAX_ATTEMPTS = 3;
const SEGMENT_DOWNLOAD_RETRY_BASE_MS = 250;

const probeSchema = z.object({
	videoUrl: z.string().url(),
});

const thumbnailSchema = z.object({
	videoUrl: z.string().url(),
	timestamp: z.number().optional(),
	width: z.number().max(2000).optional(),
	height: z.number().max(2000).optional(),
	quality: z.number().min(1).max(100).optional(),
});

const convertSchema = z.object({
	videoUrl: z.string().url(),
	inputExtension: z.string().optional(),
});

const processSchema = z.object({
	videoId: z.string(),
	userId: z.string(),
	videoUrl: z.string().url(),
	outputPresignedUrl: z.string().url(),
	thumbnailPresignedUrl: z.string().url().optional(),
	previewGifPresignedUrl: z.string().url().optional(),
	webhookUrl: z.string().url().optional(),
	webhookSecret: z.string().optional(),
	inputExtension: z.string().optional(),
	maxWidth: z.number().max(4096).optional(),
	maxHeight: z.number().max(4096).optional(),
	crf: z.number().min(0).max(51).optional(),
	preset: z.enum(["ultrafast", "fast", "medium", "slow"]).optional(),
	remuxOnly: z.boolean().optional(),
});

const editRangeSchema = z
	.object({
		start: z.number().min(0),
		end: z.number().min(0),
	})
	.refine((range) => range.end > range.start, {
		message: "Range end must be greater than start",
	});

const editSchema = z.object({
	videoId: z.string(),
	userId: z.string(),
	sourceUrl: z.string().url(),
	outputPresignedUrl: z.string().url(),
	outputVerificationUrl: z.string().url().optional(),
	thumbnailPresignedUrl: z.string().url().optional(),
	previewGifPresignedUrl: z.string().url().optional(),
	webhookUrl: z.string().url().optional(),
	webhookSecret: z.string().optional(),
	keepRanges: z.array(editRangeSchema).min(1),
});

function getInstanceId(): string {
	return process.env.HOSTNAME || `pid-${process.pid}`;
}

function logVideoEvent(event: string, data: Record<string, unknown>) {
	console.info(
		JSON.stringify({
			event,
			timestamp: new Date().toISOString(),
			instanceId: getInstanceId(),
			pid: process.pid,
			...data,
		}),
	);
}

function getVideoCapacitySnapshot() {
	const resources = getSystemResources();
	const jobs = getAllJobs();
	return {
		instanceId: getInstanceId(),
		pid: process.pid,
		activeVideoProcesses: getActiveVideoProcessCount(),
		activeDirectVideoProcesses: getActiveDirectVideoProcessCount(),
		maxConcurrentVideoProcesses: getMaxConcurrentVideoProcesses(),
		maxConcurrentDirectVideoProcesses: getMaxConcurrentDirectVideoProcesses(),
		effectiveMaxVideoProcesses: resources.effectiveMax,
		resources,
		jobCount: jobs.length,
		jobs: jobs.map((job) => ({
			jobId: job.jobId,
			videoId: job.videoId,
			phase: job.phase,
			progress: job.progress,
			updatedAt: job.updatedAt,
		})),
	};
}

function getBusyDetails(snapshot: ReturnType<typeof getVideoCapacitySnapshot>) {
	return snapshot.resources.throttleReason
		? `Throttled: ${snapshot.resources.throttleReason} (${snapshot.activeVideoProcesses}/${snapshot.resources.effectiveMax} active)`
		: `Too many concurrent video processing jobs (${snapshot.activeVideoProcesses}/${snapshot.resources.effectiveMax}), please retry later`;
}

function getBusyResponseBody(
	snapshot: ReturnType<typeof getVideoCapacitySnapshot>,
) {
	return {
		error: "Server is busy",
		code: "SERVER_BUSY",
		details: getBusyDetails(snapshot),
		...snapshot,
	};
}

function getMuxBusyResponseBody(
	snapshot: ReturnType<typeof getVideoCapacitySnapshot>,
) {
	return {
		...getBusyResponseBody(snapshot),
		error: "SERVER_BUSY",
		message: "Server is at capacity",
	};
}

function summarizeVideoInput(videoUrl: string, inputExtension?: string) {
	const extension = inputExtension?.toLowerCase() ?? null;
	try {
		const url = new URL(videoUrl);
		const pathnameExtension = url.pathname.includes(".")
			? `.${url.pathname.split(".").pop()?.toLowerCase() ?? ""}`
			: null;
		const effectiveExtension = extension ?? pathnameExtension;
		return {
			host: url.hostname,
			extension: effectiveExtension,
			streaming:
				effectiveExtension === ".m3u8" ||
				effectiveExtension === ".m3u" ||
				effectiveExtension === ".mpd",
		};
	} catch {
		return {
			host: null,
			extension,
			streaming: false,
		};
	}
}

function isBusyError(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.message.includes("Server is busy") ||
			err.message.includes("SERVER_BUSY"))
	);
}

function isTimeoutError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("timed out");
}

async function cleanupTempFiles(
	files: Array<TempFileHandle | null>,
): Promise<void> {
	await Promise.all(
		files.map(async (tempFile) => {
			if (!tempFile) return;
			try {
				await tempFile.cleanup();
			} catch {}
		}),
	);
}

async function createVideoDownloadResponse(
	outputTempFile: TempFileHandle,
	tempFiles: TempFileHandle[],
	onCleanup?: () => void,
): Promise<Response> {
	const outputFile = file(outputTempFile.path);
	const outputSize = await outputFile.size;
	let cleanedUp = false;

	const cleanup = async () => {
		if (cleanedUp) return;
		cleanedUp = true;
		await cleanupTempFiles(tempFiles);
		onCleanup?.();
	};

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = outputFile.stream().getReader();

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) controller.enqueue(value);
				}
				controller.close();
			} catch (error) {
				controller.error(error);
			} finally {
				reader.releaseLock();
				await cleanup();
			}
		},
		async cancel() {
			await cleanup();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "video/mp4",
			"Cache-Control": "no-store",
			"Content-Length": outputSize.toString(),
		},
	});
}

async function withJobHeartbeat<T>(
	jobId: string,
	operation: () => Promise<T>,
): Promise<T> {
	const interval = setInterval(() => {
		const job = getJob(jobId);
		if (
			!job ||
			job.phase === "complete" ||
			job.phase === "error" ||
			job.phase === "cancelled"
		) {
			clearInterval(interval);
			return;
		}

		touchJob(jobId);
	}, PROCESSING_HEARTBEAT_MS);
	interval.unref?.();

	try {
		return await operation();
	} finally {
		clearInterval(interval);
	}
}

async function withMuxMemoryGuard<T>(
	abortController: AbortController,
	operation: () => Promise<T>,
): Promise<T> {
	let memoryPressureExceeded = false;
	const interval = setInterval(() => {
		if (!hasCriticalMemoryPressure()) return;
		memoryPressureExceeded = true;
		abortController.abort();
	}, 1000);
	interval.unref?.();

	try {
		const result = await operation();
		if (memoryPressureExceeded) {
			throw new Error(VIDEO_MEMORY_PRESSURE_ERROR);
		}
		return result;
	} catch (error) {
		if (memoryPressureExceeded) {
			throw new Error(VIDEO_MEMORY_PRESSURE_ERROR);
		}
		throw error;
	} finally {
		clearInterval(interval);
	}
}

video.get("/status", (c) => {
	const jobs = getAllJobs();
	const resources = getSystemResources();
	const now = Date.now();
	return c.json({
		instanceId: getInstanceId(),
		pid: process.pid,
		activeVideoProcesses: getActiveVideoProcessCount(),
		maxConcurrentVideoProcesses: getMaxConcurrentVideoProcesses(),
		effectiveMaxVideoProcesses: resources.effectiveMax,
		maxConcurrentDirectVideoProcesses: getMaxConcurrentDirectVideoProcesses(),
		activeProbeProcesses: getActiveProbeProcessCount(),
		canAcceptNewVideoProcess: canAcceptNewVideoProcess(),
		canAcceptNewProbeProcess: canAcceptNewProbeProcess(),
		resources,
		activeDirectVideoProcesses: getActiveDirectVideoProcessCount(),
		jobCount: jobs.length,
		jobs: jobs.map((j) => ({
			jobId: j.jobId,
			videoId: j.videoId,
			phase: j.phase,
			progress: j.progress,
			createdAt: j.createdAt,
			updatedAt: j.updatedAt,
			ageMinutes: Math.round((now - j.createdAt) / 60000),
			stalenessMinutes: Math.round((now - j.updatedAt) / 60000),
			error: j.error,
		})),
	});
});

video.post("/probe", async (c) => {
	if (!validateMediaServerSecret(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const body = await c.req.json();
	const result = probeSchema.safeParse(body);

	if (!result.success) {
		return c.json(
			{
				error: "Invalid request",
				code: "INVALID_REQUEST",
				details: result.error.message,
			},
			400,
		);
	}

	try {
		const metadata = await probeVideo(result.data.videoUrl);
		return c.json({ metadata });
	} catch (err) {
		console.error("[video/probe] Error:", err);

		if (isBusyError(err)) {
			return c.json(
				{
					error: "Server is busy",
					code: "SERVER_BUSY",
					details: "Too many concurrent requests, please retry later",
				},
				503,
			);
		}

		if (isTimeoutError(err)) {
			return c.json(
				{
					error: "Request timed out",
					code: "TIMEOUT",
					details: err instanceof Error ? err.message : String(err),
				},
				504,
			);
		}

		return c.json(
			{
				error: "Failed to probe video",
				code: PROBE_ERROR_CODE,
				details: err instanceof Error ? err.message : String(err),
			},
			500,
		);
	}
});

video.post("/thumbnail", async (c) => {
	if (!validateMediaServerSecret(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const body = await c.req.json();
	const result = thumbnailSchema.safeParse(body);

	if (!result.success) {
		return c.json(
			{
				error: "Invalid request",
				code: "INVALID_REQUEST",
				details: result.error.message,
			},
			400,
		);
	}

	try {
		const metadata = await probeVideo(result.data.videoUrl);

		const thumbnailData = await generateThumbnail(
			result.data.videoUrl,
			metadata.duration,
			{
				timestamp: result.data.timestamp,
				width: result.data.width,
				height: result.data.height,
				quality: result.data.quality,
			},
		);

		return new Response(Buffer.from(thumbnailData), {
			headers: {
				"Content-Type": "image/jpeg",
				"Content-Length": thumbnailData.length.toString(),
			},
		});
	} catch (err) {
		console.error("[video/thumbnail] Error:", err);

		if (isBusyError(err)) {
			return c.json(
				{
					error: "Server is busy",
					code: "SERVER_BUSY",
					details: "Too many concurrent requests, please retry later",
				},
				503,
			);
		}

		if (isTimeoutError(err)) {
			return c.json(
				{
					error: "Request timed out",
					code: "TIMEOUT",
					details: err instanceof Error ? err.message : String(err),
				},
				504,
			);
		}

		return c.json(
			{
				error: "Failed to generate thumbnail",
				code: MEDIA_ENGINE_ERROR_CODE,
				details: err instanceof Error ? err.message : String(err),
			},
			500,
		);
	}
});

video.post("/convert", async (c) => {
	if (!validateMediaServerSecret(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const body = await c.req.json();
	const result = convertSchema.safeParse(body);

	if (!result.success) {
		return c.json(
			{
				error: "Invalid request",
				code: "INVALID_REQUEST",
				details: result.error.message,
			},
			400,
		);
	}

	let inputTempFile: TempFileHandle | null = null;
	let outputTempFile: TempFileHandle | null = null;
	let slot: VideoProcessSlot | null = null;
	const requestId = crypto.randomUUID();
	const startedAt = Date.now();

	try {
		slot = tryAcquireDirectVideoProcessSlot(canAcceptNewVideoProcess);
		const capacity = getVideoCapacitySnapshot();
		if (!slot) {
			c.header("Retry-After", VIDEO_BUSY_RETRY_AFTER_SECONDS.toString());
			logVideoEvent("video_convert_rejected", {
				requestId,
				reason: "capacity",
				...capacity,
			});
			return c.json(getBusyResponseBody(capacity), 503);
		}

		logVideoEvent("video_convert_started", {
			requestId,
			input: summarizeVideoInput(
				result.data.videoUrl,
				result.data.inputExtension,
			),
			...capacity,
		});

		inputTempFile = await downloadVideoToTemp(
			result.data.videoUrl,
			result.data.inputExtension,
			c.req.raw.signal,
		);

		const metadata = await probeVideoFile(inputTempFile.path);
		outputTempFile = await processVideo(
			inputTempFile.path,
			metadata,
			{
				maxWidth: metadata.width > 0 ? metadata.width : undefined,
				maxHeight: metadata.height > 0 ? metadata.height : undefined,
			},
			undefined,
			c.req.raw.signal,
		);

		const outputSize = await file(outputTempFile.path).size;
		logVideoEvent("video_convert_succeeded", {
			requestId,
			durationMs: Date.now() - startedAt,
			outputSize,
			metadata: {
				duration: metadata.duration,
				width: metadata.width,
				height: metadata.height,
				videoCodec: metadata.videoCodec,
				audioCodec: metadata.audioCodec,
				fileSize: metadata.fileSize,
			},
			...getVideoCapacitySnapshot(),
		});

		return await createVideoDownloadResponse(
			outputTempFile,
			[inputTempFile, outputTempFile],
			slot.release,
		);
	} catch (err) {
		slot?.release();
		await cleanupTempFiles([outputTempFile, inputTempFile]);
		logVideoEvent("video_convert_failed", {
			requestId,
			durationMs: Date.now() - startedAt,
			error: err instanceof Error ? err.message : String(err),
			...getVideoCapacitySnapshot(),
		});
		console.error("[video/convert] Error:", err);

		if (isBusyError(err)) {
			c.header("Retry-After", VIDEO_BUSY_RETRY_AFTER_SECONDS.toString());
			return c.json(
				{
					error: "Server is busy",
					code: "SERVER_BUSY",
					details: "Too many concurrent requests, please retry later",
				},
				503,
			);
		}

		if (isTimeoutError(err)) {
			return c.json(
				{
					error: "Request timed out",
					code: "TIMEOUT",
					details: err instanceof Error ? err.message : String(err),
				},
				504,
			);
		}

		return c.json(
			{
				error: "Failed to convert video",
				code: MEDIA_ENGINE_ERROR_CODE,
				details: err instanceof Error ? err.message : String(err),
			},
			500,
		);
	}
});

video.post("/process", async (c) => {
	if (!validateMediaServerSecret(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const body = await c.req.json();
	const result = processSchema.safeParse(body);

	if (!result.success) {
		return c.json(
			{
				error: "Invalid request",
				code: "INVALID_REQUEST",
				details: result.error.message,
			},
			400,
		);
	}

	if (!canAcceptNewVideoProcess()) {
		c.header("Retry-After", VIDEO_BUSY_RETRY_AFTER_SECONDS.toString());
		return c.json(getBusyResponseBody(getVideoCapacitySnapshot()), 503);
	}

	const {
		videoId,
		userId,
		videoUrl,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
		webhookUrl,
		webhookSecret,
	} = result.data;

	const jobId = generateJobId();
	const job = createJob(jobId, videoId, userId, webhookUrl, webhookSecret);

	processVideoAsync(
		job.jobId,
		videoUrl,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
		result.data,
	).catch((err) => {
		console.error(
			`[video/process] Async processing error for job ${jobId}:`,
			err,
		);
		const currentJob = getJob(jobId);
		if (
			currentJob &&
			currentJob.phase !== "error" &&
			currentJob.phase !== "complete" &&
			currentJob.phase !== "cancelled"
		) {
			updateJob(jobId, {
				phase: "error",
				error: err instanceof Error ? err.message : String(err),
				message: "Processing failed (unhandled)",
			});
		}
	});

	return c.json({
		jobId,
		status: "queued",
		message: "Video processing started",
	});
});

video.post("/edit", async (c) => {
	if (!validateMediaServerSecret(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid request", code: "INVALID_REQUEST" }, 400);
	}
	const result = editSchema.safeParse(body);

	if (!result.success) {
		return c.json(
			{
				error: "Invalid request",
				code: "INVALID_REQUEST",
				details: result.error.message,
			},
			400,
		);
	}

	if (!canAcceptNewVideoProcess()) {
		c.header("Retry-After", VIDEO_BUSY_RETRY_AFTER_SECONDS.toString());
		return c.json(getBusyResponseBody(getVideoCapacitySnapshot()), 503);
	}

	const {
		videoId,
		userId,
		sourceUrl,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
		webhookUrl,
		webhookSecret,
	} = result.data;

	const jobId = generateJobId();
	const job = createJob(jobId, videoId, userId, webhookUrl, webhookSecret);

	editVideoAsync(
		job.jobId,
		sourceUrl,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
		result.data,
	).catch((err) => {
		console.error(`[video/edit] Async edit error for job ${jobId}:`, err);
		const currentJob = getJob(jobId);
		if (
			currentJob &&
			currentJob.phase !== "error" &&
			currentJob.phase !== "complete" &&
			currentJob.phase !== "cancelled"
		) {
			updateJob(jobId, {
				phase: "error",
				error: err instanceof Error ? err.message : String(err),
				message: "Edit failed (unhandled)",
			});
		}
	});

	return c.json({
		jobId,
		status: "queued",
		message: "Video edit started",
	});
});

function isWebmInput(extension: string | undefined): boolean {
	if (!extension) return false;
	const normalized = extension.toLowerCase().replace(/^\./, "");
	return normalized === "webm";
}

function needsContainerRepair(metadata: VideoMetadata): boolean {
	return (
		metadata.duration <= 0 || metadata.width === 0 || metadata.height === 0
	);
}

const RESILIENT_FLAGS: ResilientInputFlags = {
	errDetectIgnoreErr: true,
	genPts: true,
	discardCorrupt: true,
	maxMuxingQueueSize: 1024,
};

async function probeWithRepairFallback(
	inputPath: string,
	isWebm: boolean,
	abortSignal: AbortSignal,
): Promise<{ metadata: VideoMetadata; repairedFile: TempFileHandle | null }> {
	let probeError: unknown = null;
	let metadata: VideoMetadata | null = null;

	try {
		metadata = await probeVideoFile(inputPath);
	} catch (err) {
		probeError = err;
		console.warn(
			`[probeWithRepairFallback] Initial probe failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (metadata && !needsContainerRepair(metadata)) {
		return { metadata, repairedFile: null };
	}

	if (!isWebm) {
		if (probeError) throw probeError;
		if (metadata) return { metadata, repairedFile: null };
		throw new Error("Probe returned no metadata");
	}

	console.log(
		`[probeWithRepairFallback] Attempting container repair (probe ${probeError ? "failed" : `returned duration=${metadata?.duration}`})`,
	);

	const repairedFile = await repairContainer(inputPath, abortSignal);

	try {
		const repairedMetadata = await probeVideoFile(repairedFile.path);

		if (repairedMetadata.duration <= 0 && metadata && metadata.duration > 0) {
			console.log(
				"[probeWithRepairFallback] Repaired file has worse duration; using original metadata with repaired file",
			);
			return { metadata, repairedFile };
		}

		console.log(
			`[probeWithRepairFallback] Repair successful: duration=${repairedMetadata.duration}, ${repairedMetadata.width}x${repairedMetadata.height}`,
		);
		return { metadata: repairedMetadata, repairedFile };
	} catch (reProbeErr) {
		console.error(
			`[probeWithRepairFallback] Re-probe after repair also failed: ${reProbeErr instanceof Error ? reProbeErr.message : String(reProbeErr)}`,
		);
		await repairedFile.cleanup();

		if (metadata) {
			return { metadata, repairedFile: null };
		}

		throw probeError ?? reProbeErr;
	}
}

async function processWithResilientRetry(
	inputPath: string,
	originalInputPath: string,
	metadata: VideoMetadata,
	options: z.infer<typeof processSchema>,
	isWebm: boolean,
	jobId: string,
	abortSignal: AbortSignal,
): Promise<{
	outputFile: TempFileHandle;
	lastResortRepairFile: TempFileHandle | null;
}> {
	const processOptions = {
		maxWidth: options.maxWidth,
		maxHeight: options.maxHeight,
		crf: options.crf,
		preset: options.preset,
		remuxOnly: options.remuxOnly,
	};

	const onProgress = (progress: number, message: string) => {
		const scaledProgress = 10 + progress * 0.7;
		updateJob(jobId, { progress: scaledProgress, message });
		const currentJob = getJob(jobId);
		if (currentJob) {
			void sendWebhook(currentJob).catch((error) =>
				console.warn(
					`[video/process] Failed to send webhook update for job ${jobId}:`,
					error,
				),
			);
		}
	};

	return await withJobHeartbeat(jobId, async () => {
		try {
			const outputFile = await processVideo(
				inputPath,
				metadata,
				processOptions,
				onProgress,
				abortSignal,
			);
			return { outputFile, lastResortRepairFile: null };
		} catch (firstError) {
			if (!isWebm) throw firstError;

			console.warn(
				`[processWithResilientRetry] First transcode attempt failed: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
			);

			updateJob(jobId, {
				progress: 10,
				message: "Retrying with error recovery...",
			});

			try {
				const outputFile = await processVideo(
					inputPath,
					metadata,
					processOptions,
					onProgress,
					abortSignal,
					RESILIENT_FLAGS,
				);
				return { outputFile, lastResortRepairFile: null };
			} catch (retryError) {
				console.warn(
					`[processWithResilientRetry] Resilient retry also failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
				);
			}

			console.log(
				"[processWithResilientRetry] Attempting last-resort container repair and transcode...",
			);

			updateJob(jobId, {
				progress: 10,
				message: "Attempting full repair...",
			});

			let lastResortRepairFile: TempFileHandle | null = null;
			try {
				lastResortRepairFile = await repairContainer(
					originalInputPath,
					abortSignal,
				);

				let repairedMetadata: VideoMetadata;
				try {
					repairedMetadata = await probeVideoFile(lastResortRepairFile.path);
				} catch {
					repairedMetadata = metadata;
				}

				const outputFile = await processVideo(
					lastResortRepairFile.path,
					repairedMetadata,
					processOptions,
					onProgress,
					abortSignal,
					RESILIENT_FLAGS,
				);
				return { outputFile, lastResortRepairFile };
			} catch (lastResortError) {
				console.error(
					`[processWithResilientRetry] Last-resort repair+transcode failed: ${lastResortError instanceof Error ? lastResortError.message : String(lastResortError)}`,
				);
				await lastResortRepairFile?.cleanup();
				throw lastResortError;
			}
		}
	});
}

async function generateAndUploadPreviewGif(
	inputPath: string,
	duration: number,
	previewGifPresignedUrl: string | undefined,
	abortSignal: AbortSignal | undefined,
	logPrefix: string,
): Promise<void> {
	if (!previewGifPresignedUrl) return;

	let previewGifFile: TempFileHandle | null = null;

	try {
		previewGifFile = await generatePreviewGif(
			inputPath,
			duration,
			{},
			abortSignal,
		);
		await uploadFileToS3(
			previewGifFile.path,
			previewGifPresignedUrl,
			"image/gif",
		);
	} catch (previewErr) {
		if (abortSignal?.aborted) {
			throw previewErr instanceof Error
				? previewErr
				: new Error("Preview GIF generation aborted");
		}
		console.warn(`[${logPrefix}] Preview GIF generation failed:`, previewErr);
	} finally {
		await previewGifFile?.cleanup();
	}
}

const UPLOAD_VERIFICATION_ATTEMPTS = 4;
const UPLOAD_VERIFICATION_RETRY_MS = 1000;

function getDurationTolerance(duration: number) {
	if (!Number.isFinite(duration) || duration <= 0) return 0.5;
	return Math.max(0.5, Math.min(5, duration * 0.01));
}

function isDurationClose(actual: number, expected: number) {
	return (
		Number.isFinite(actual) &&
		Number.isFinite(expected) &&
		Math.abs(actual - expected) <= getDurationTolerance(expected)
	);
}

async function waitForVerificationRetry(attempt: number) {
	await new Promise((resolve) =>
		setTimeout(resolve, UPLOAD_VERIFICATION_RETRY_MS * (attempt + 1)),
	);
}

async function verifyUploadedVideo(
	outputVerificationUrl: string | undefined,
	expectedMetadata: VideoMetadata,
) {
	if (!outputVerificationUrl) return;

	let lastError: Error | undefined;

	for (let attempt = 0; attempt < UPLOAD_VERIFICATION_ATTEMPTS; attempt++) {
		try {
			const actualMetadata = await probeVideo(outputVerificationUrl);
			if (isDurationClose(actualMetadata.duration, expectedMetadata.duration)) {
				return;
			}

			lastError = new Error(
				`Uploaded video duration mismatch: expected ${expectedMetadata.duration.toFixed(3)}s, got ${actualMetadata.duration.toFixed(3)}s`,
			);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}

		if (attempt < UPLOAD_VERIFICATION_ATTEMPTS - 1) {
			await waitForVerificationRetry(attempt);
		}
	}

	throw lastError ?? new Error("Uploaded video verification failed");
}

async function editVideoAsync(
	jobId: string,
	sourceUrl: string,
	outputPresignedUrl: string,
	thumbnailPresignedUrl: string | undefined,
	previewGifPresignedUrl: string | undefined,
	options: z.infer<typeof editSchema>,
): Promise<void> {
	if (!getJob(jobId)) {
		return;
	}

	const abortController = new AbortController();
	updateJob(jobId, { abortController });

	try {
		updateJob(jobId, {
			phase: "downloading",
			progress: 0,
			message: "Downloading source video...",
		});
		const downloadingJob = getJob(jobId);
		if (downloadingJob) {
			await sendWebhook(downloadingJob);
		}

		const inputTempFile = await downloadVideoToTemp(
			sourceUrl,
			".mp4",
			abortController.signal,
		);
		updateJob(jobId, { inputTempFile });

		updateJob(jobId, {
			phase: "probing",
			progress: 5,
			message: "Analyzing source video...",
		});
		const probingJob = getJob(jobId);
		if (probingJob) {
			await sendWebhook(probingJob);
		}

		const sourceMetadata = await probeVideoFile(inputTempFile.path);

		updateJob(jobId, {
			phase: "processing",
			progress: 10,
			message: "Applying edit...",
		});
		const processingJob = getJob(jobId);
		if (processingJob) {
			await sendWebhook(processingJob);
		}

		const outputTempFile = await withJobHeartbeat(jobId, () =>
			renderEditedVideo({
				inputPath: inputTempFile.path,
				keepRanges: options.keepRanges,
				metadata: sourceMetadata,
				abortSignal: abortController.signal,
				onProgress: (progress, message) => {
					updateJob(jobId, {
						progress: Math.min(80, 10 + progress * 0.9),
						message,
					});
					const currentJob = getJob(jobId);
					if (currentJob) {
						void sendWebhook(currentJob).catch((error) =>
							console.warn(
								`[video/edit] Failed to send webhook update for job ${jobId}:`,
								error,
							),
						);
					}
				},
			}),
		);
		updateJob(jobId, { outputTempFile });

		const outputMetadata = await probeVideoFile(outputTempFile.path);
		updateJob(jobId, { metadata: outputMetadata });

		updateJob(jobId, {
			phase: "uploading",
			progress: 80,
			message: "Uploading edited video...",
		});
		const uploadingJob = getJob(jobId);
		if (uploadingJob) {
			await sendWebhook(uploadingJob);
		}

		await uploadFileToS3(outputTempFile.path, outputPresignedUrl, "video/mp4");
		await verifyUploadedVideo(options.outputVerificationUrl, outputMetadata);

		if (thumbnailPresignedUrl || previewGifPresignedUrl) {
			updateJob(jobId, {
				phase: "generating_thumbnail",
				progress: 90,
				message: "Generating preview assets...",
			});
			const thumbnailJob = getJob(jobId);
			if (thumbnailJob) {
				await sendWebhook(thumbnailJob);
			}
		}

		if (thumbnailPresignedUrl) {
			const thumbnailData = await generateThumbnail(
				outputTempFile.path,
				outputMetadata.duration,
			);
			await uploadToS3(thumbnailData, thumbnailPresignedUrl, "image/jpeg");
		}

		await generateAndUploadPreviewGif(
			outputTempFile.path,
			outputMetadata.duration,
			previewGifPresignedUrl,
			abortController.signal,
			"video/edit",
		);

		updateJob(jobId, {
			phase: "complete",
			progress: 100,
			message: "Edit complete",
		});
		const completedJob = getJob(jobId);
		if (completedJob) {
			await sendWebhook(completedJob);
		}

		await inputTempFile.cleanup();
		await outputTempFile.cleanup();

		setTimeout(() => deleteJob(jobId), 5 * 60 * 1000);
	} catch (err) {
		console.error(`[video/edit] Error editing job ${jobId}:`, err);

		const updatedJob = updateJob(jobId, {
			phase: "error",
			error: err instanceof Error ? err.message : String(err),
			message: "Edit failed",
		});

		try {
			if (updatedJob) {
				await sendWebhook(updatedJob);
			}
		} finally {
			const currentJob = getJob(jobId);
			if (currentJob) {
				await Promise.allSettled([
					currentJob.inputTempFile?.cleanup(),
					currentJob.outputTempFile?.cleanup(),
				]);
			}

			setTimeout(() => deleteJob(jobId), 5 * 60 * 1000);
		}
	}
}

async function processVideoAsync(
	jobId: string,
	videoUrl: string,
	outputPresignedUrl: string,
	thumbnailPresignedUrl: string | undefined,
	previewGifPresignedUrl: string | undefined,
	options: z.infer<typeof processSchema>,
): Promise<void> {
	const job = getJob(jobId);
	if (!job) {
		return;
	}

	const abortController = new AbortController();
	updateJob(jobId, { abortController });

	let repairedTempFile: TempFileHandle | null = null;
	let lastResortRepairFile: TempFileHandle | null = null;

	try {
		updateJob(jobId, {
			phase: "downloading",
			progress: 0,
			message: "Downloading video...",
		});
		await sendWebhook(job);

		const inputTempFile = await downloadVideoToTemp(
			videoUrl,
			options.inputExtension,
			abortController.signal,
		);
		updateJob(jobId, { inputTempFile });

		const isWebm = isWebmInput(options.inputExtension);

		updateJob(jobId, {
			phase: "probing",
			progress: 5,
			message: "Analyzing video...",
		});
		await sendWebhook(job);

		const { metadata, repairedFile } = await probeWithRepairFallback(
			inputTempFile.path,
			isWebm,
			abortController.signal,
		);
		repairedTempFile = repairedFile;
		updateJob(jobId, { metadata });

		const processingInputPath = repairedFile
			? repairedFile.path
			: inputTempFile.path;

		updateJob(jobId, {
			phase: "processing",
			progress: 10,
			message: repairedFile
				? "Processing repaired video..."
				: "Processing video...",
		});
		await sendWebhook(job);

		const { outputFile: outputTempFile, lastResortRepairFile: lrrf } =
			await processWithResilientRetry(
				processingInputPath,
				inputTempFile.path,
				metadata,
				options,
				isWebm,
				jobId,
				abortController.signal,
			);
		lastResortRepairFile = lrrf;
		updateJob(jobId, { outputTempFile });

		updateJob(jobId, {
			phase: "uploading",
			progress: 80,
			message: "Uploading processed video...",
		});
		await sendWebhook(job);

		await uploadFileToS3(outputTempFile.path, outputPresignedUrl, "video/mp4");

		if (thumbnailPresignedUrl || previewGifPresignedUrl) {
			updateJob(jobId, {
				phase: "generating_thumbnail",
				progress: 90,
				message: "Generating preview assets...",
			});
			await sendWebhook(job);
		}

		if (thumbnailPresignedUrl) {
			const thumbnailData = await generateThumbnail(
				outputTempFile.path,
				metadata.duration,
			);
			await uploadToS3(thumbnailData, thumbnailPresignedUrl, "image/jpeg");
		}

		await generateAndUploadPreviewGif(
			outputTempFile.path,
			metadata.duration,
			previewGifPresignedUrl,
			abortController.signal,
			"video/process",
		);

		updateJob(jobId, {
			phase: "complete",
			progress: 100,
			message: "Processing complete",
		});
		const completedJob = getJob(jobId);
		if (completedJob) {
			await sendWebhook(completedJob);
		}

		await inputTempFile.cleanup();
		await outputTempFile.cleanup();
		await repairedTempFile?.cleanup();
		await lastResortRepairFile?.cleanup();

		setTimeout(() => deleteJob(jobId), 5 * 60 * 1000);
	} catch (err) {
		console.error(`[video/process] Error processing job ${jobId}:`, err);

		const updatedJob = updateJob(jobId, {
			phase: "error",
			error: err instanceof Error ? err.message : String(err),
			message: "Processing failed",
		});

		if (updatedJob) {
			await sendWebhook(updatedJob);
		}

		const currentJob = getJob(jobId);
		if (currentJob) {
			await currentJob.inputTempFile?.cleanup();
			await currentJob.outputTempFile?.cleanup();
		}
		await repairedTempFile?.cleanup();
		await lastResortRepairFile?.cleanup();
	}
}

video.get("/process/:jobId/status", async (c) => {
	const jobId = c.req.param("jobId");
	const job = getJob(jobId);

	if (!job) {
		return c.json(
			{
				error: "Job not found",
				code: "NOT_FOUND",
				instanceId: getInstanceId(),
				pid: process.pid,
			},
			404,
		);
	}

	const accept = c.req.header("Accept");

	if (accept?.includes("text/event-stream")) {
		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();

				const sendUpdate = () => {
					const currentJob = getJob(jobId);
					if (!currentJob) {
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({ error: "Job not found" })}\n\n`,
							),
						);
						controller.close();
						return false;
					}

					const progress = getJobProgress(currentJob);
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(progress)}\n\n`),
					);

					if (
						currentJob.phase === "complete" ||
						currentJob.phase === "error" ||
						currentJob.phase === "cancelled"
					) {
						controller.close();
						return false;
					}

					return true;
				};

				sendUpdate();

				const interval = setInterval(() => {
					if (!sendUpdate()) {
						clearInterval(interval);
					}
				}, 1000);

				c.req.raw.signal.addEventListener("abort", () => {
					clearInterval(interval);
					controller.close();
				});
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	}

	return c.json(getJobProgress(job));
});

video.post("/process/:jobId/cancel", async (c) => {
	if (!validateMediaServerSecret(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	const jobId = c.req.param("jobId");
	const job = getJob(jobId);

	if (!job) {
		return c.json(
			{
				error: "Job not found",
				code: "NOT_FOUND",
				instanceId: getInstanceId(),
				pid: process.pid,
			},
			404,
		);
	}

	if (
		job.phase === "complete" ||
		job.phase === "error" ||
		job.phase === "cancelled"
	) {
		return c.json(
			{
				error: "Job already finished",
				code: "INVALID_STATE",
				currentPhase: job.phase,
			},
			400,
		);
	}

	job.abortController?.abort();

	updateJob(jobId, {
		phase: "cancelled",
		message: "Processing cancelled by user",
	});

	const cancelledJob = getJob(jobId);
	if (cancelledJob) {
		await sendWebhook(cancelledJob);
	}

	return c.json({
		success: true,
		message: "Job cancelled",
	});
});

video.post("/cleanup", async (c) => {
	if (!validateMediaServerSecret(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	const cleaned = await cleanupStaleTempFiles();
	return c.json({
		success: true,
		cleanedFiles: cleaned,
	});
});

video.post("/force-cleanup", (c) => {
	if (!validateMediaServerSecret(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	const cleaned = forceCleanupActiveJobs();
	return c.json({
		success: true,
		cleanedJobs: cleaned,
		message: `Force-cleaned ${cleaned} active jobs`,
	});
});

const muxSegmentsOutputUploadSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("put"),
		url: z.string().url(),
	}),
	z.object({
		type: z.literal("multipart"),
		videoId: z.string(),
		key: z.string().min(1),
		uploadId: z.string().min(1),
		partSize: z
			.number()
			.int()
			.min(5 * 1024 * 1024),
		signPartUrl: z.string().url(),
		completeUrl: z.string().url(),
		abortUrl: z.string().url(),
		webhookSecret: z.string().optional(),
	}),
]);

const muxSegmentsSchema = z
	.object({
		videoId: z.string(),
		userId: z.string(),
		outputPresignedUrl: z.string().url().optional(),
		outputUpload: muxSegmentsOutputUploadSchema.optional(),
		thumbnailPresignedUrl: z.string().url().optional(),
		previewGifPresignedUrl: z.string().url().optional(),
		webhookUrl: z.string().url().optional(),
		webhookSecret: z.string().optional(),
		videoInitUrl: z.string().url(),
		videoSegmentUrls: z.array(z.string().url()),
		audioInitUrl: z.string().url().optional(),
		audioSegmentUrls: z.array(z.string().url()).optional(),
	})
	.refine((body) => body.outputPresignedUrl || body.outputUpload, {
		message: "outputPresignedUrl or outputUpload is required",
		path: ["outputUpload"],
	});

function getMuxSegmentsOutputUpload(
	body: z.infer<typeof muxSegmentsSchema>,
): StorageUploadTarget {
	if (body.outputUpload) return body.outputUpload;
	if (body.outputPresignedUrl) {
		return { type: "put", url: body.outputPresignedUrl };
	}
	throw new Error("Missing mux output upload target");
}

video.post("/mux-segments", async (c) => {
	if (!validateMediaServerSecret(c)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const body = muxSegmentsSchema.safeParse(await c.req.json());
	if (!body.success) {
		return c.json(
			{ error: "Invalid request", details: body.error.issues },
			400,
		);
	}

	const {
		videoId,
		userId,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
		webhookUrl,
		webhookSecret,
	} = body.data;
	const jobId = generateJobId();

	if (!canAcceptNewVideoProcess()) {
		c.header("Retry-After", VIDEO_BUSY_RETRY_AFTER_SECONDS.toString());
		return c.json(getMuxBusyResponseBody(getVideoCapacitySnapshot()), 503);
	}

	createJob(jobId, videoId, userId, webhookUrl, webhookSecret);

	const {
		videoInitUrl,
		videoSegmentUrls: videoSegUrls,
		audioInitUrl,
		audioSegmentUrls: audioSegUrls,
	} = body.data;
	const outputUpload = getMuxSegmentsOutputUpload(body.data);

	muxSegmentsAsync(
		jobId,
		videoId,
		outputUpload,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
		videoInitUrl,
		videoSegUrls,
		audioInitUrl ?? null,
		audioSegUrls ?? null,
	).catch((err) => {
		console.error(`[mux-segments] Async mux error for job ${jobId}:`, err);
		const currentJob = getJob(jobId);
		if (
			currentJob &&
			currentJob.phase !== "error" &&
			currentJob.phase !== "complete"
		) {
			updateJob(jobId, {
				phase: "error",
				error: err instanceof Error ? err.message : String(err),
			});
			sendCurrentJobWebhook(jobId);
		}
	});

	return c.json({
		jobId,
		status: "queued",
		videoId,
	});
});

async function streamConcatFiles(
	inputPaths: string[],
	outputPath: string,
): Promise<void> {
	const writer = file(outputPath).writer();
	let lastMemoryCheckAt = 0;
	try {
		for (const filePath of inputPaths) {
			const reader = file(filePath).stream().getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					writer.write(value);
					const now = Date.now();
					if (now - lastMemoryCheckAt >= 1000) {
						lastMemoryCheckAt = now;
						if (hasCriticalMemoryPressure()) {
							throw new Error(VIDEO_MEMORY_PRESSURE_ERROR);
						}
					}
				}
			} finally {
				reader.releaseLock();
			}
		}
	} finally {
		await writer.end();
	}
}

function redactPresignedUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return url.split("?")[0] ?? url;
	}
}

class MediaDownloadError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
	}
}

function isRetryableDownloadStatus(status: number): boolean {
	return (
		status === 408 ||
		status === 425 ||
		status === 429 ||
		status === 500 ||
		status === 502 ||
		status === 503 ||
		status === 504
	);
}

async function downloadUrlToFileOnce(
	url: string,
	destPath: string,
	abortSignal?: AbortSignal,
): Promise<void> {
	const abortController = new AbortController();
	const timeoutSignal = AbortSignal.timeout(120_000);
	const resp = await fetch(url, {
		signal: abortSignal
			? AbortSignal.any([abortController.signal, abortSignal, timeoutSignal])
			: AbortSignal.any([abortController.signal, timeoutSignal]),
	});
	if (!resp.ok) {
		await resp.body?.cancel().catch(() => {});
		throw new MediaDownloadError(
			`Download failed (${resp.status}): ${redactPresignedUrl(url)}`,
			isRetryableDownloadStatus(resp.status),
		);
	}
	if (!resp.body) {
		throw new MediaDownloadError(
			`Download returned no body: ${redactPresignedUrl(url)}`,
			true,
		);
	}

	const reader = resp.body.getReader();
	const writer = file(destPath).writer();
	let lastMemoryCheckAt = 0;
	let failure: unknown;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			writer.write(value);
			const now = Date.now();
			if (now - lastMemoryCheckAt >= 1000) {
				lastMemoryCheckAt = now;
				if (hasCriticalMemoryPressure()) {
					throw new Error(VIDEO_MEMORY_PRESSURE_ERROR);
				}
			}
		}
	} catch (error) {
		failure = error;
		abortController.abort();
		await reader.cancel().catch(() => {});
	} finally {
		reader.releaseLock();
		try {
			await writer.end();
		} catch (error) {
			failure ??= error;
		}
	}

	if (failure !== undefined) {
		const { rm } = await import("node:fs/promises");
		await rm(destPath, { force: true }).catch(() => {});
		throw failure instanceof Error
			? failure
			: new Error("Download failed while streaming response body");
	}
}

async function downloadUrlToFile(
	url: string,
	destPath: string,
	abortSignal?: AbortSignal,
): Promise<void> {
	let lastError: Error | undefined;

	for (let attempt = 0; attempt < SEGMENT_DOWNLOAD_MAX_ATTEMPTS; attempt++) {
		abortSignal?.throwIfAborted();
		try {
			await downloadUrlToFileOnce(url, destPath, abortSignal);
			return;
		} catch (error) {
			if (abortSignal?.aborted) throw error;
			if (isBusyError(error)) throw error;

			const downloadError =
				error instanceof Error ? error : new Error(String(error));
			if (error instanceof MediaDownloadError && !error.retryable) {
				throw downloadError;
			}
			lastError = downloadError;
		}

		if (attempt < SEGMENT_DOWNLOAD_MAX_ATTEMPTS - 1) {
			await Bun.sleep(SEGMENT_DOWNLOAD_RETRY_BASE_MS * 2 ** attempt);
		}
	}

	throw lastError ?? new Error("Download failed");
}

async function downloadSegmentsBatchTracked(
	urls: string[],
	dir: string,
	jobId: string,
	progressBase: number,
	progressRange: number,
): Promise<string[]> {
	const { join } = await import("node:path");
	let completed = 0;
	let fatalError: Error | undefined;
	const total = urls.length;
	const indexWidth = Math.max(3, String(total).length);
	const outputPaths = new Array<string>(total);
	const pending = [...urls.entries()];
	let pendingIndex = 0;
	const batchAbortController = new AbortController();
	const CONCURRENCY = 10;

	async function worker() {
		while (pendingIndex < pending.length && !fatalError) {
			const entry = pending[pendingIndex++];
			if (!entry) break;
			const [i, url] = entry;
			try {
				const outputPath = join(
					dir,
					`segment_${String(i + 1).padStart(indexWidth, "0")}.m4s`,
				);
				outputPaths[i] = outputPath;
				await downloadUrlToFile(url, outputPath, batchAbortController.signal);
			} catch (err) {
				if (!fatalError) {
					fatalError = err instanceof Error ? err : new Error(String(err));
					pendingIndex = pending.length;
					batchAbortController.abort();
					console.error(
						`[mux-segments] Failed to download segment ${i + 1}/${total}:`,
						err instanceof Error ? err.message : err,
					);
				}
				break;
			}
			completed++;
			if (total > 0) {
				updateJob(jobId, {
					phase: "downloading",
					progress:
						progressBase + Math.round((completed / total) * progressRange),
				});
			}
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()),
	);
	if (fatalError) throw fatalError;
	return outputPaths;
}

function sendCurrentJobWebhook(jobId: string): void {
	const job = getJob(jobId);
	if (!job) {
		console.warn(`[mux-segments] Job ${jobId} not found for webhook`);
		return;
	}
	sendWebhook(job);
}

async function muxSegmentsAsync(
	jobId: string,
	videoId: string,
	outputUpload: StorageUploadTarget,
	thumbnailPresignedUrl: string | undefined,
	previewGifPresignedUrl: string | undefined,
	videoInitUrl: string,
	videoSegmentUrls: string[],
	audioInitUrl: string | null,
	audioSegmentUrls: string[] | null,
): Promise<void> {
	const { ensureTempDir } = await import("../lib/temp-files");
	const { mkdir, rm } = await import("node:fs/promises");
	const { join } = await import("node:path");

	const workDir = join(
		(await import("node:os")).tmpdir(),
		"cap-media-server",
		`mux-${jobId}`,
	);
	const abortController = new AbortController();
	updateJob(jobId, { abortController });
	let outputUploadStarted = false;
	const startedAt = Date.now();

	try {
		logVideoEvent("video_mux_started", {
			jobId,
			videoId,
			videoSegmentCount: videoSegmentUrls.length,
			audioSegmentCount: audioSegmentUrls?.length ?? 0,
			...getVideoCapacitySnapshot(),
		});
		await ensureTempDir();
		updateJob(jobId, { phase: "downloading", progress: 0 });
		sendCurrentJobWebhook(jobId);

		await mkdir(workDir, { recursive: true });
		const videoDir = join(workDir, "video");
		const audioDir = join(workDir, "audio");
		await mkdir(videoDir, { recursive: true });
		await mkdir(audioDir, { recursive: true });

		await downloadUrlToFile(videoInitUrl, join(videoDir, "init.mp4"));
		updateJob(jobId, { phase: "downloading", progress: 5 });
		sendCurrentJobWebhook(jobId);

		const videoSegmentFiles = await downloadSegmentsBatchTracked(
			videoSegmentUrls,
			videoDir,
			jobId,
			5,
			45,
		);

		const audioInput =
			audioInitUrl !== null &&
			audioSegmentUrls !== null &&
			audioSegmentUrls.length > 0
				? { initUrl: audioInitUrl, segmentUrls: audioSegmentUrls }
				: null;
		let audioSegmentFiles: string[] = [];
		if (audioInput) {
			await downloadUrlToFile(audioInput.initUrl, join(audioDir, "init.mp4"));
			audioSegmentFiles = await downloadSegmentsBatchTracked(
				audioInput.segmentUrls,
				audioDir,
				jobId,
				50,
				10,
			);
		}

		updateJob(jobId, { phase: "processing", progress: 60 });
		sendCurrentJobWebhook(jobId);

		const combinedVideoPath = join(workDir, "combined_video.mp4");
		const videoInitPath = join(videoDir, "init.mp4");

		await streamConcatFiles(
			[videoInitPath, ...videoSegmentFiles],
			combinedVideoPath,
		);
		await rm(videoDir, { recursive: true, force: true });

		let combinedAudioPath: string | null = null;

		if (audioInput) {
			combinedAudioPath = join(workDir, "combined_audio.mp4");
			const audioInitPath = join(audioDir, "init.mp4");

			await streamConcatFiles(
				[audioInitPath, ...audioSegmentFiles],
				combinedAudioPath,
			);
			await rm(audioDir, { recursive: true, force: true });
		}

		if (hasCriticalMemoryPressure()) {
			throw new Error(VIDEO_MEMORY_PRESSURE_ERROR);
		}
		logVideoEvent("video_mux_inputs_materialized", {
			jobId,
			videoId,
			combinedVideoSize: file(combinedVideoPath).size,
			combinedAudioSize: combinedAudioPath ? file(combinedAudioPath).size : 0,
			resources: getSystemResources(),
		});

		const resultPath = join(workDir, "result.mp4");
		await withMuxMemoryGuard(abortController, () =>
			muxMediaTracksToMp4(
				combinedVideoPath,
				combinedAudioPath,
				resultPath,
				abortController.signal,
			),
		);
		await rm(combinedVideoPath, { force: true });
		if (combinedAudioPath) {
			await rm(combinedAudioPath, { force: true });
		}
		logVideoEvent("video_mux_output_ready", {
			jobId,
			videoId,
			outputSize: file(resultPath).size,
			durationMs: Date.now() - startedAt,
			resources: getSystemResources(),
		});

		updateJob(jobId, { phase: "uploading", progress: 80 });
		sendCurrentJobWebhook(jobId);

		outputUploadStarted = true;
		await uploadFileToStorage(resultPath, outputUpload, "video/mp4");

		let metadata: VideoMetadata | undefined;
		try {
			const probeResult = await probeVideoFile(resultPath);
			metadata = probeResult;
		} catch {}

		if (thumbnailPresignedUrl || previewGifPresignedUrl) {
			updateJob(jobId, {
				phase: "generating_thumbnail",
				progress: 90,
				message: "Generating preview assets...",
			});
			sendCurrentJobWebhook(jobId);
		}

		if (thumbnailPresignedUrl) {
			try {
				const duration = metadata?.duration ?? 0;
				const thumbnailData = await generateThumbnail(resultPath, duration);
				await uploadToS3(thumbnailData, thumbnailPresignedUrl, "image/jpeg");
			} catch (thumbErr) {
				console.warn(
					`[mux-segments] Thumbnail generation failed for ${videoId}:`,
					thumbErr,
				);
			}
		}

		await generateAndUploadPreviewGif(
			resultPath,
			metadata?.duration ?? 0,
			previewGifPresignedUrl,
			abortController.signal,
			"mux-segments",
		);

		updateJob(jobId, {
			phase: "complete",
			progress: 100,
			metadata,
		});
		sendCurrentJobWebhook(jobId);
		logVideoEvent("video_mux_succeeded", {
			jobId,
			videoId,
			durationMs: Date.now() - startedAt,
			metadata,
			resources: getSystemResources(),
		});

		setTimeout(() => deleteJob(jobId), 5 * 60 * 1000);
	} catch (error: unknown) {
		logVideoEvent("video_mux_failed", {
			jobId,
			videoId,
			durationMs: Date.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
			resources: getSystemResources(),
		});
		if (!outputUploadStarted) {
			await abortStorageUploadTarget(outputUpload).catch((abortError) => {
				console.warn(
					`[mux-segments] Failed to abort output upload for ${videoId}:`,
					abortError instanceof Error ? abortError.message : abortError,
				);
			});
		}
		console.error(`Mux-segments job ${jobId} failed:`, error);
		updateJob(jobId, {
			phase: "error",
			error: error instanceof Error ? error.message : "Unknown error",
		});
		sendCurrentJobWebhook(jobId);
	} finally {
		await rm(workDir, { recursive: true, force: true }).catch(() => {});
	}
}

export default video;
