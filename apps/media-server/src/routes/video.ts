import { file } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import type { ResilientInputFlags } from "../lib/ffmpeg-video";
import {
	downloadVideoToTemp,
	generateSpriteSheet,
	generateThumbnail,
	processVideo,
	repairContainer,
	uploadFileToS3,
	uploadToS3,
} from "../lib/ffmpeg-video";
import {
	canAcceptNewProbeProcess,
	getActiveProbeProcessCount,
	probeVideo,
	probeVideoFile,
} from "../lib/ffprobe";
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
	sendWebhook,
	updateJob,
} from "../lib/job-manager";
import type { TempFileHandle } from "../lib/temp-files";
import { cleanupStaleTempFiles } from "../lib/temp-files";

const video = new Hono();

function validateMediaServerSecret(c: {
	req: { header: (name: string) => string | undefined };
}): boolean {
	const secret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	if (!secret) {
		console.warn(
			"[media-server] MEDIA_SERVER_WEBHOOK_SECRET is not set — rejecting request. Set this env var to enable authenticated access.",
		);
		return false;
	}
	return c.req.header("x-media-server-secret") === secret;
}

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
	spriteSheetPresignedUrl: z.string().url().optional(),
	spriteVttPresignedUrl: z.string().url().optional(),
	webhookUrl: z.string().url().optional(),
	webhookSecret: z.string().optional(),
	inputExtension: z.string().optional(),
	maxWidth: z.number().max(4096).optional(),
	maxHeight: z.number().max(4096).optional(),
	crf: z.number().min(0).max(51).optional(),
	preset: z.enum(["ultrafast", "fast", "medium", "slow"]).optional(),
	remuxOnly: z.boolean().optional(),
});

function getInstanceId(): string {
	return process.env.HOSTNAME || `pid-${process.pid}`;
}

function isBusyError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("Server is busy");
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
): Promise<Response> {
	const outputFile = file(outputTempFile.path);
	const outputSize = await outputFile.size;
	let cleanedUp = false;

	const cleanup = async () => {
		if (cleanedUp) return;
		cleanedUp = true;
		await cleanupTempFiles(tempFiles);
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
		activeProbeProcesses: getActiveProbeProcessCount(),
		canAcceptNewVideoProcess: canAcceptNewVideoProcess(),
		canAcceptNewProbeProcess: canAcceptNewProbeProcess(),
		resources,
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
				code: "FFPROBE_ERROR",
				details: err instanceof Error ? err.message : String(err),
			},
			500,
		);
	}
});

video.post("/thumbnail", async (c) => {
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
				code: "FFMPEG_ERROR",
				details: err instanceof Error ? err.message : String(err),
			},
			500,
		);
	}
});

video.post("/convert", async (c) => {
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

	try {
		inputTempFile = await downloadVideoToTemp(
			result.data.videoUrl,
			result.data.inputExtension,
		);

		const metadata = await probeVideoFile(inputTempFile.path);
		outputTempFile = await processVideo(inputTempFile.path, metadata, {
			maxWidth: metadata.width > 0 ? metadata.width : undefined,
			maxHeight: metadata.height > 0 ? metadata.height : undefined,
		});

		return await createVideoDownloadResponse(outputTempFile, [
			inputTempFile,
			outputTempFile,
		]);
	} catch (err) {
		await cleanupTempFiles([outputTempFile, inputTempFile]);
		console.error("[video/convert] Error:", err);

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
				error: "Failed to convert video",
				code: "FFMPEG_ERROR",
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
		const activeVideoProcesses = getActiveVideoProcessCount();
		const resources = getSystemResources();
		const jobs = getAllJobs();
		return c.json(
			{
				error: "Server is busy",
				code: "SERVER_BUSY",
				details: resources.throttleReason
					? `Throttled: ${resources.throttleReason} (${activeVideoProcesses}/${resources.effectiveMax} active)`
					: `Too many concurrent video processing jobs (${activeVideoProcesses}/${resources.effectiveMax}), please retry later`,
				instanceId: getInstanceId(),
				pid: process.pid,
				activeVideoProcesses,
				maxConcurrentVideoProcesses: getMaxConcurrentVideoProcesses(),
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
			},
			503,
		);
	}

	const {
		videoId,
		userId,
		videoUrl,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		spriteSheetPresignedUrl,
		spriteVttPresignedUrl,
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
		spriteSheetPresignedUrl,
		spriteVttPresignedUrl,
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
			sendWebhook(currentJob);
		}
	};

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
}

async function processVideoAsync(
	jobId: string,
	videoUrl: string,
	outputPresignedUrl: string,
	thumbnailPresignedUrl: string | undefined,
	spriteSheetPresignedUrl: string | undefined,
	spriteVttPresignedUrl: string | undefined,
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

		if (thumbnailPresignedUrl) {
			updateJob(jobId, {
				phase: "generating_thumbnail",
				progress: 90,
				message: "Generating thumbnail...",
			});
			await sendWebhook(job);

			const thumbnailData = await generateThumbnail(
				outputTempFile.path,
				metadata.duration,
			);
			await uploadToS3(thumbnailData, thumbnailPresignedUrl, "image/jpeg");
		}

		if (spriteSheetPresignedUrl && spriteVttPresignedUrl) {
			try {
				updateJob(jobId, {
					phase: "generating_sprites",
					progress: 93,
					message: "Generating preview sprites...",
				});
				await sendWebhook(job);

				const spriteResult = await generateSpriteSheet(
					outputTempFile.path,
					metadata.duration,
				);
				await uploadToS3(
					spriteResult.imageData,
					spriteSheetPresignedUrl,
					"image/jpeg",
				);
				const vttBlob = new Blob([spriteResult.vttContent], {
					type: "text/vtt",
				});
				await uploadToS3(
					new Uint8Array(await vttBlob.arrayBuffer()),
					spriteVttPresignedUrl,
					"text/vtt",
				);
			} catch (spriteErr) {
				console.error(
					`[video/process] Sprite generation failed for job ${jobId} (non-fatal):`,
					spriteErr,
				);
			}
		}

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

const muxSegmentsSchema = z.object({
	videoId: z.string(),
	userId: z.string(),
	outputPresignedUrl: z.string().url(),
	thumbnailPresignedUrl: z.string().url().optional(),
	spriteSheetPresignedUrl: z.string().url().optional(),
	spriteVttPresignedUrl: z.string().url().optional(),
	webhookUrl: z.string().url().optional(),
	webhookSecret: z.string().optional(),
	videoInitUrl: z.string().url(),
	videoSegmentUrls: z.array(z.string().url()),
	audioInitUrl: z.string().url().optional(),
	audioSegmentUrls: z.array(z.string().url()).optional(),
});

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
		outputPresignedUrl,
		thumbnailPresignedUrl,
		spriteSheetPresignedUrl,
		spriteVttPresignedUrl,
		webhookUrl,
		webhookSecret,
	} = body.data;
	const jobId = generateJobId();

	if (!canAcceptNewVideoProcess()) {
		return c.json(
			{
				error: "SERVER_BUSY",
				message: "Server is at capacity",
			},
			503,
		);
	}

	createJob(jobId, videoId, userId, webhookUrl, webhookSecret);

	const {
		videoInitUrl,
		videoSegmentUrls: videoSegUrls,
		audioInitUrl,
		audioSegmentUrls: audioSegUrls,
	} = body.data;

	muxSegmentsAsync(
		jobId,
		videoId,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		spriteSheetPresignedUrl,
		spriteVttPresignedUrl,
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
			sendWebhook(getJob(jobId)!);
		}
	});

	return c.json({
		jobId,
		status: "queued",
		videoId,
	});
});

const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000;

async function runFfmpeg(args: string[]): Promise<void> {
	const proc = Bun.spawn(["ffmpeg", ...args], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const stderrPromise = new Response(proc.stderr).text();
	const timeout = setTimeout(() => {
		proc.kill();
	}, FFMPEG_TIMEOUT_MS);
	try {
		const exitCode = await proc.exited;
		const stderrText = await stderrPromise;
		if (exitCode !== 0) {
			throw new Error(
				`FFmpeg exited with code ${exitCode}: ${stderrText.slice(-500)}`,
			);
		}
	} finally {
		clearTimeout(timeout);
	}
}

async function streamConcatFiles(
	inputPaths: string[],
	outputPath: string,
): Promise<void> {
	const { open, readFile } = await import("node:fs/promises");
	const handle = await open(outputPath, "w");
	try {
		for (const filePath of inputPaths) {
			const data = await readFile(filePath);
			await handle.write(data);
		}
	} finally {
		await handle.close();
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

async function downloadUrlToFile(url: string, destPath: string): Promise<void> {
	const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) });
	if (!resp.ok) {
		throw new Error(
			`Download failed (${resp.status}): ${redactPresignedUrl(url)}`,
		);
	}
	const data = Buffer.from(await resp.arrayBuffer());
	const { writeFile } = await import("node:fs/promises");
	await writeFile(destPath, data);
}

async function downloadSegmentsBatchTracked(
	urls: string[],
	dir: string,
	jobId: string,
	progressBase: number,
	progressRange: number,
): Promise<number> {
	const { join } = await import("node:path");
	let completed = 0;
	let failed = 0;
	const total = urls.length;
	const pending = [...urls.entries()];
	const CONCURRENCY = 10;

	async function worker() {
		while (pending.length > 0) {
			const entry = pending.shift();
			if (!entry) break;
			const [i, url] = entry;
			try {
				await downloadUrlToFile(
					url,
					join(dir, `segment_${String(i + 1).padStart(3, "0")}.m4s`),
				);
			} catch (err) {
				failed++;
				console.error(
					`[mux-segments] Failed to download segment ${i + 1}/${total}:`,
					err instanceof Error ? err.message : err,
				);
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
	return failed;
}

async function muxSegmentsAsync(
	jobId: string,
	videoId: string,
	outputPresignedUrl: string,
	thumbnailPresignedUrl: string | undefined,
	spriteSheetPresignedUrl: string | undefined,
	spriteVttPresignedUrl: string | undefined,
	videoInitUrl: string,
	videoSegmentUrls: string[],
	audioInitUrl: string | null,
	audioSegmentUrls: string[] | null,
): Promise<void> {
	const { ensureTempDir } = await import("../lib/temp-files");
	const { mkdir, readdir } = await import("node:fs/promises");
	const { join } = await import("node:path");

	const workDir = join(
		(await import("node:os")).tmpdir(),
		"cap-media-server",
		`mux-${jobId}`,
	);

	try {
		await ensureTempDir();
		updateJob(jobId, { phase: "downloading", progress: 0 });
		sendWebhook(getJob(jobId)!);

		await mkdir(workDir, { recursive: true });
		const videoDir = join(workDir, "video");
		const audioDir = join(workDir, "audio");
		await mkdir(videoDir, { recursive: true });
		await mkdir(audioDir, { recursive: true });

		await downloadUrlToFile(videoInitUrl, join(videoDir, "init.mp4"));
		updateJob(jobId, { phase: "downloading", progress: 5 });
		sendWebhook(getJob(jobId)!);

		const videoFailed = await downloadSegmentsBatchTracked(
			videoSegmentUrls,
			videoDir,
			jobId,
			5,
			45,
		);

		if (videoFailed > 0) {
			const failRatio = videoFailed / videoSegmentUrls.length;
			if (failRatio >= 0.5) {
				throw new Error(
					`Too many video segments failed: ${videoFailed}/${videoSegmentUrls.length} (${Math.round(failRatio * 100)}%)`,
				);
			}
			console.warn(
				`[mux-segments] ${videoFailed}/${videoSegmentUrls.length} video segments failed to download for ${videoId}`,
			);
		}

		let hasAudio =
			audioInitUrl !== null &&
			audioSegmentUrls !== null &&
			audioSegmentUrls.length > 0;
		if (hasAudio) {
			await downloadUrlToFile(audioInitUrl!, join(audioDir, "init.mp4"));
			const audioFailed = await downloadSegmentsBatchTracked(
				audioSegmentUrls!,
				audioDir,
				jobId,
				50,
				10,
			);
			if (audioFailed > 0) {
				const audioFailRatio = audioFailed / audioSegmentUrls!.length;
				if (audioFailRatio >= 0.5) {
					console.warn(
						`[mux-segments] ${audioFailed}/${audioSegmentUrls!.length} audio segments failed for ${videoId} (${Math.round(audioFailRatio * 100)}%), proceeding without audio`,
					);
					hasAudio = false;
				} else {
					console.warn(
						`[mux-segments] ${audioFailed}/${audioSegmentUrls!.length} audio segments failed to download for ${videoId}`,
					);
				}
			}
		}

		updateJob(jobId, { phase: "processing", progress: 60 });
		sendWebhook(getJob(jobId)!);

		const combinedVideoPath = join(workDir, "combined_video.mp4");
		const videoInitPath = join(videoDir, "init.mp4");
		const videoSegmentFiles = (await readdir(videoDir))
			.filter((f) => f.endsWith(".m4s"))
			.sort()
			.map((f) => join(videoDir, f));

		await streamConcatFiles(
			[videoInitPath, ...videoSegmentFiles],
			combinedVideoPath,
		);

		const videoOnlyPath = join(workDir, "video_only.mp4");
		await runFfmpeg([
			"-y",
			"-i",
			combinedVideoPath,
			"-c",
			"copy",
			videoOnlyPath,
		]);

		let resultPath: string;

		if (hasAudio) {
			const combinedAudioPath = join(workDir, "combined_audio.mp4");
			const audioInitPath = join(audioDir, "init.mp4");
			const audioSegmentFiles = (await readdir(audioDir))
				.filter((f) => f.endsWith(".m4s"))
				.sort()
				.map((f) => join(audioDir, f));

			await streamConcatFiles(
				[audioInitPath, ...audioSegmentFiles],
				combinedAudioPath,
			);

			resultPath = join(workDir, "result.mp4");
			await runFfmpeg([
				"-y",
				"-i",
				videoOnlyPath,
				"-i",
				combinedAudioPath,
				"-c",
				"copy",
				"-movflags",
				"+faststart",
				resultPath,
			]);
		} else {
			resultPath = join(workDir, "result.mp4");
			await runFfmpeg([
				"-y",
				"-i",
				videoOnlyPath,
				"-c",
				"copy",
				"-movflags",
				"+faststart",
				resultPath,
			]);
		}

		updateJob(jobId, { phase: "uploading", progress: 80 });
		sendWebhook(getJob(jobId)!);

		await uploadFileToS3(resultPath, outputPresignedUrl, "video/mp4");

		let metadata: VideoMetadata | undefined;
		try {
			const probeResult = await probeVideoFile(resultPath);
			metadata = {
				width: probeResult.width,
				height: probeResult.height,
				duration: probeResult.duration,
				fps: probeResult.fps,
			};
		} catch {}

		if (thumbnailPresignedUrl) {
			updateJob(jobId, {
				phase: "generating_thumbnail",
				progress: 90,
				message: "Generating thumbnail...",
			});
			sendWebhook(getJob(jobId)!);

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

		if (spriteSheetPresignedUrl && spriteVttPresignedUrl) {
			try {
				updateJob(jobId, {
					phase: "generating_sprites",
					progress: 93,
					message: "Generating preview sprites...",
				});
				sendWebhook(getJob(jobId)!);

				const duration = metadata?.duration ?? 0;
				const spriteResult = await generateSpriteSheet(resultPath, duration);
				await uploadToS3(
					spriteResult.imageData,
					spriteSheetPresignedUrl,
					"image/jpeg",
				);
				const vttBlob = new Blob([spriteResult.vttContent], {
					type: "text/vtt",
				});
				await uploadToS3(
					new Uint8Array(await vttBlob.arrayBuffer()),
					spriteVttPresignedUrl,
					"text/vtt",
				);
			} catch (spriteErr) {
				console.warn(
					`[mux-segments] Sprite generation failed for ${videoId} (non-fatal):`,
					spriteErr,
				);
			}
		}

		updateJob(jobId, {
			phase: "complete",
			progress: 100,
			metadata,
		});
		sendWebhook(getJob(jobId)!);

		setTimeout(() => deleteJob(jobId), 5 * 60 * 1000);
	} catch (error: unknown) {
		console.error(`Mux-segments job ${jobId} failed:`, error);
		updateJob(jobId, {
			phase: "error",
			error: error instanceof Error ? error.message : "Unknown error",
		});
		sendWebhook(getJob(jobId)!);
	} finally {
		const { rm } = await import("node:fs/promises");
		await rm(workDir, { recursive: true, force: true }).catch(() => {});
	}
}

export default video;
