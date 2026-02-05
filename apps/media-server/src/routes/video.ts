import { normalizeConfigForRender } from "@cap/editor-render-spec";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { processVideoWithCanvasPipeline } from "../lib/canvas-pipeline";
import {
	downloadVideoToTemp,
	generateThumbnail,
	processVideo,
	processVideoWithTimeline,
	type TimelineSegment,
	uploadFileToS3,
	uploadToS3,
	useCanvasRenderer,
} from "../lib/ffmpeg-video";
import {
	canAcceptNewProbeProcess,
	getActiveProbeProcessCount,
	probeVideo,
} from "../lib/ffprobe";
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
	incrementActiveVideoProcesses,
	sendWebhook,
	updateJob,
} from "../lib/job-manager";
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
	maxWidth: z.number().max(4096).optional(),
	maxHeight: z.number().max(4096).optional(),
	crf: z.number().min(0).max(51).optional(),
	preset: z.enum(["ultrafast", "fast", "medium", "slow"]).optional(),
	remuxOnly: z.boolean().optional(),
});

const editorTimelineSegmentSchema = z.object({
	start: z.number(),
	end: z.number(),
	timescale: z.number(),
});

const editorProcessSchema = z.object({
	videoId: z.string(),
	userId: z.string(),
	videoUrl: z.string().url(),
	outputPresignedUrl: z.string().url(),
	webhookUrl: z.string().url().optional(),
	projectConfig: z
		.object({
			timeline: z
				.object({
					segments: z.array(editorTimelineSegmentSchema),
				})
				.nullable()
				.optional(),
		})
		.passthrough(),
});

function isBusyError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("Server is busy");
}

function isTimeoutError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("timed out");
}

function getEditorTimelineSegments(
	projectConfig: z.infer<typeof editorProcessSchema>["projectConfig"],
	duration: number,
): TimelineSegment[] {
	const segments = projectConfig.timeline?.segments;

	if (!segments || segments.length === 0) {
		return [{ start: 0, end: duration, timescale: 1 }];
	}

	return segments.map((segment) => ({
		start: segment.start,
		end: segment.end,
		timescale: segment.timescale,
	}));
}

video.get("/status", (c) => {
	const jobs = getAllJobs();
	return c.json({
		activeVideoProcesses: getActiveVideoProcessCount(),
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
		return c.json(
			{
				error: "Server is busy",
				code: "SERVER_BUSY",
				details:
					"Too many concurrent video processing jobs, please retry later",
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

video.post("/editor/process", async (c) => {
	const body = await c.req.json();
	const result = editorProcessSchema.safeParse(body);

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
		return c.json(
			{
				error: "Server is busy",
				code: "SERVER_BUSY",
				details:
					"Too many concurrent video processing jobs, please retry later",
			},
			503,
		);
	}

	const normalized = normalizeConfigForRender(result.data.projectConfig);
	const errors = normalized.issues.filter(
		(issue) => issue.severity === "error",
	);
	if (errors.length > 0) {
		return c.json(
			{
				error: "Unsupported editor config",
				code: "UNSUPPORTED_CONFIG",
				details: errors
					.slice(0, 5)
					.map((issue) => `${issue.path}: ${issue.code}`)
					.join("; "),
				issues: errors,
			},
			400,
		);
	}

	const { videoId, userId, videoUrl, outputPresignedUrl, webhookUrl } =
		result.data;

	const jobId = generateJobId();
	const job = createJob(jobId, videoId, userId, webhookUrl);

	incrementActiveVideoProcesses();

	processEditorVideoAsync(
		job.jobId,
		videoUrl,
		outputPresignedUrl,
		result.data.projectConfig,
	).catch((err) => {
		console.error(
			`[video/editor/process] Async processing error for job ${jobId}:`,
			err,
		);
	});

	return c.json({
		jobId,
		status: "queued",
		message: "Editor render started",
	});
});

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

	try {
		updateJob(jobId, {
			phase: "downloading",
			progress: 0,
			message: "Downloading video...",
		});
		await sendWebhook(job);

		const inputTempFile = await downloadVideoToTemp(
			videoUrl,
			abortController.signal,
		);
		updateJob(jobId, { inputTempFile });

		updateJob(jobId, {
			phase: "probing",
			progress: 5,
			message: "Analyzing video...",
		});
		await sendWebhook(job);

		const metadata = await probeVideo(inputTempFile.path);
		updateJob(jobId, { metadata });

		updateJob(jobId, {
			phase: "processing",
			progress: 10,
			message: "Processing video...",
		});
		await sendWebhook(job);

		const outputTempFile = await processVideo(
			inputTempFile.path,
			metadata,
			{
				maxWidth: options.maxWidth,
				maxHeight: options.maxHeight,
				crf: options.crf,
				preset: options.preset,
				remuxOnly: options.remuxOnly,
			},
			(progress, message) => {
				const scaledProgress = 10 + progress * 0.7;
				updateJob(jobId, { progress: scaledProgress, message });
				const currentJob = getJob(jobId);
				if (currentJob) {
					void sendWebhook(currentJob);
				}
			},
			abortController.signal,
		);
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
		const completedJob = getJob(jobId);
		if (completedJob) {
			await sendWebhook(completedJob);
		}

		await inputTempFile.cleanup();
		await outputTempFile.cleanup();

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
	} finally {
		decrementActiveVideoProcesses();
	}
}

async function processEditorVideoAsync(
	jobId: string,
	videoUrl: string,
	outputPresignedUrl: string,
	projectConfig: z.infer<typeof editorProcessSchema>["projectConfig"],
): Promise<void> {
	const job = getJob(jobId);
	if (!job) {
		decrementActiveVideoProcesses();
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
		await sendWebhook(job);

		const inputTempFile = await downloadVideoToTemp(
			videoUrl,
			abortController.signal,
		);
		updateJob(jobId, { inputTempFile });

		updateJob(jobId, {
			phase: "probing",
			progress: 5,
			message: "Analyzing source video...",
		});
		await sendWebhook(job);

		const sourceMetadata = await probeVideo(inputTempFile.path);
		updateJob(jobId, { metadata: sourceMetadata });

		updateJob(jobId, {
			phase: "processing",
			progress: 10,
			message: "Rendering saved changes...",
		});
		await sendWebhook(job);

		const timelineSegments = getEditorTimelineSegments(
			projectConfig,
			sourceMetadata.duration,
		);

		const processFunc = useCanvasRenderer()
			? processVideoWithCanvasPipeline
			: processVideoWithTimeline;

		const outputTempFile = await processFunc(
			inputTempFile.path,
			sourceMetadata,
			timelineSegments,
			projectConfig,
			{},
			(progress, message) => {
				const scaledProgress = 10 + progress * 0.8;
				updateJob(jobId, { progress: scaledProgress, message });
				const currentJob = getJob(jobId);
				if (currentJob) {
					void sendWebhook(currentJob);
				}
			},
			abortController.signal,
		);
		updateJob(jobId, { outputTempFile });

		const outputMetadata = await probeVideo(outputTempFile.path);
		updateJob(jobId, { metadata: outputMetadata });

		updateJob(jobId, {
			phase: "uploading",
			progress: 92,
			message: "Uploading saved video...",
		});
		await sendWebhook(job);

		await uploadFileToS3(outputTempFile.path, outputPresignedUrl, "video/mp4");

		updateJob(jobId, {
			phase: "complete",
			progress: 100,
			message: "Saved changes are ready",
			metadata: outputMetadata,
		});
		const completedJob = getJob(jobId);
		if (completedJob) {
			await sendWebhook(completedJob);
		}

		await inputTempFile.cleanup();
		await outputTempFile.cleanup();

		setTimeout(() => deleteJob(jobId), 5 * 60 * 1000);
	} catch (err) {
		console.error(`[video/editor/process] Error processing job ${jobId}:`, err);

		const updatedJob = updateJob(jobId, {
			phase: "error",
			error: err instanceof Error ? err.message : String(err),
			message: "Editor render failed",
		});

		if (updatedJob) {
			await sendWebhook(updatedJob);
		}

		const currentJob = getJob(jobId);
		if (currentJob) {
			await currentJob.inputTempFile?.cleanup();
			await currentJob.outputTempFile?.cleanup();
		}
	} finally {
		decrementActiveVideoProcesses();
	}
}

async function getJobStatusResponse(c: Context, jobId: string) {
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
}

async function cancelJobResponse(c: Context, jobId: string) {
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

	const updatedJob = getJob(jobId);
	if (updatedJob) {
		await sendWebhook(updatedJob);
	}

	return c.json({
		success: true,
		message: "Job cancelled",
	});
}

video.get("/process/:jobId/status", async (c) => {
	const jobId = c.req.param("jobId");
	return getJobStatusResponse(c, jobId);
});

video.get("/editor/process/:jobId/status", async (c) => {
	const jobId = c.req.param("jobId");
	return getJobStatusResponse(c, jobId);
});

video.post("/process/:jobId/cancel", async (c) => {
	const jobId = c.req.param("jobId");
	return cancelJobResponse(c, jobId);
});

video.post("/editor/process/:jobId/cancel", async (c) => {
	const jobId = c.req.param("jobId");
	return cancelJobResponse(c, jobId);
});

video.post("/cleanup", async (c) => {
	const cleaned = await cleanupStaleTempFiles();
	return c.json({
		success: true,
		cleanedFiles: cleaned,
	});
});

export default video;
