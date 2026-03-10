import { Hono } from "hono";
import { z } from "zod";
import type { ResilientInputFlags } from "../lib/ffmpeg-video";
import {
	downloadVideoToTemp,
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
	decrementActiveVideoProcesses,
	deleteJob,
	generateJobId,
	getActiveVideoProcessCount,
	getAllJobs,
	getJob,
	getJobProgress,
	getMaxConcurrentVideoProcesses,
	incrementActiveVideoProcesses,
	sendWebhook,
	updateJob,
} from "../lib/job-manager";
import type { TempFileHandle } from "../lib/temp-files";
import { cleanupStaleTempFiles } from "../lib/temp-files";

const video = new Hono();

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

const processSchema = z.object({
	videoId: z.string(),
	userId: z.string(),
	videoUrl: z.string().url(),
	outputPresignedUrl: z.string().url(),
	thumbnailPresignedUrl: z.string().url().optional(),
	webhookUrl: z.string().url().optional(),
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

video.get("/status", (c) => {
	const jobs = getAllJobs();
	return c.json({
		instanceId: getInstanceId(),
		pid: process.pid,
		activeVideoProcesses: getActiveVideoProcessCount(),
		maxConcurrentVideoProcesses: getMaxConcurrentVideoProcesses(),
		activeProbeProcesses: getActiveProbeProcessCount(),
		canAcceptNewVideoProcess: canAcceptNewVideoProcess(),
		canAcceptNewProbeProcess: canAcceptNewProbeProcess(),
		jobCount: jobs.length,
		jobs: jobs.map((j) => ({
			jobId: j.jobId,
			videoId: j.videoId,
			phase: j.phase,
			progress: j.progress,
			createdAt: j.createdAt,
			updatedAt: j.updatedAt,
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

video.post("/process", async (c) => {
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
		const maxConcurrentVideoProcesses = getMaxConcurrentVideoProcesses();
		const jobs = getAllJobs();
		return c.json(
			{
				error: "Server is busy",
				code: "SERVER_BUSY",
				details: `Too many concurrent video processing jobs (${activeVideoProcesses}/${maxConcurrentVideoProcesses}), please retry later`,
				instanceId: getInstanceId(),
				pid: process.pid,
				activeVideoProcesses,
				maxConcurrentVideoProcesses,
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
		webhookUrl,
	} = result.data;

	const jobId = generateJobId();
	const job = createJob(jobId, videoId, userId, webhookUrl);

	incrementActiveVideoProcesses();

	processVideoAsync(
		job.jobId,
		videoUrl,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		result.data,
	).catch((err) => {
		console.error(
			`[video/process] Async processing error for job ${jobId}:`,
			err,
		);
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
	options: z.infer<typeof processSchema>,
): Promise<void> {
	const job = getJob(jobId);
	if (!job) {
		decrementActiveVideoProcesses();
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

		updateJob(jobId, {
			phase: "complete",
			progress: 100,
			message: "Processing complete",
		});
		await sendWebhook(getJob(jobId)!);

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
	} finally {
		decrementActiveVideoProcesses();
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

	await sendWebhook(getJob(jobId)!);

	return c.json({
		success: true,
		message: "Job cancelled",
	});
});

video.post("/cleanup", async (c) => {
	const cleaned = await cleanupStaleTempFiles();
	return c.json({
		success: true,
		cleanedFiles: cleaned,
	});
});

export default video;
