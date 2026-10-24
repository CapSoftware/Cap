import { mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	type Job,
	sendWebhook,
	updateJob,
	type VideoMetadata,
} from "../lib/job-manager";
import {
	abortStorageUploadTarget,
	generatePreviewGif,
	generateThumbnail,
	getFfmpegHlsCapabilities,
	LOOM_IMPORT_MAX_BYTES,
	materializeStreamingInput,
	type StorageUploadTarget,
	uploadFileToS3,
	uploadFileToStorage,
	uploadToS3,
} from "../lib/media-video";
import { downloadUrlToPathParallel } from "../lib/parallel-download";
import type { TempFileHandle } from "../lib/temp-files";
import {
	assertAllowedSourceUrl,
	createAllowedFetch,
	type Semaphore,
} from "./fetch";
import {
	buildRemuxArgs,
	chooseContainer,
	PLAYLIST_INPUT_ARGS,
	probeCodecs,
	probeOutput,
	runCommand,
} from "./media";
import { prefetchMaterializedHls, UnsupportedStreamError } from "./streaming";

const storageUploadSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("put"),
		url: z.string().url(),
		ifNoneMatch: z.literal("*").optional(),
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
		loomImportAttemptId: z.string().min(1).max(200).optional(),
	}),
]);

export const importRequestSchema = z.object({
	videoId: z.string().min(1),
	userId: z.string().min(1),
	videoUrl: z.string().url(),
	outputPresignedUrl: z.string().url(),
	outputUpload: storageUploadSchema.optional(),
	sourceUpload: storageUploadSchema.optional(),
	originalUpload: z
		.object({
			key: z.string().min(1).endsWith(".webm"),
			upload: storageUploadSchema,
		})
		.optional(),
	existingOutput: z
		.object({
			url: z.string().url(),
			objectIdentity: z.string().regex(/^"[^"\r\n]+"$/),
			fileSize: z.number().int().positive().max(LOOM_IMPORT_MAX_BYTES),
		})
		.optional(),
	maxImportBytes: z
		.number()
		.int()
		.positive()
		.max(LOOM_IMPORT_MAX_BYTES)
		.optional(),
	thumbnailPresignedUrl: z.string().url().optional(),
	previewGifPresignedUrl: z.string().url().optional(),
	webhookUrl: z.string().url().optional(),
	webhookSecret: z.string().optional(),
	importPriority: z.enum(["customer", "bulk"]).optional(),
});

export type ImportRequest = z.infer<typeof importRequestSchema>;

export interface ImporterSettings {
	workRoot: string;
	allowedHosts: string[];
	globalSemaphore: Semaphore;
	jobConnections: number;
	rangedConnections: number;
	segmentAttempts: number;
	segmentTimeoutMs: number;
	remuxTimeoutMs: number;
	terminalWebhookAttempts: number;
	minFreeBytes: number;
}

function isStreamingUrl(url: string): boolean {
	const path = (url.split("?")[0] ?? "").toLowerCase();
	return path.endsWith(".m3u8") || path.endsWith(".mpd");
}

function withSizeLimit(fetchImpl: typeof fetch, maxBytes: number) {
	const limited = async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await fetchImpl(input, init);
		const total = Number(
			response.headers.get("content-range")?.split("/")[1] ??
				response.headers.get("content-length"),
		);
		if (Number.isFinite(total) && total > maxBytes) {
			await response.body?.cancel().catch(() => {});
			throw new Error("Loom imports are limited to 10 GB");
		}
		return response;
	};
	return Object.assign(limited, { preconnect: fetch.preconnect });
}

async function deliverTerminalWebhook(job: Job, attempts: number) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		await sendWebhook(job);
		if (job.terminalWebhookAcknowledgedAt || !job.webhookUrl) return;
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(60_000, 2_000 * 2 ** attempt)),
		);
	}
	console.error(
		`[loom-importer] Terminal webhook was not acknowledged for ${job.jobId}`,
	);
}

export class ProgressWebhookThrottle {
	private readonly last = new Map<string, { at: number; phase: string }>();

	constructor(private readonly intervalMs: number) {}

	shouldSend(jobId: string, phase: string, now: number) {
		const last = this.last.get(jobId);
		if (last && last.phase === phase && now - last.at < this.intervalMs)
			return false;
		this.last.set(jobId, { at: now, phase });
		return true;
	}

	forget(jobId: string) {
		this.last.delete(jobId);
	}
}

const progressWebhooks = new ProgressWebhookThrottle(15_000);

function progressUpdate(
	jobId: string,
	phase: Job["phase"],
	progress: number,
	message: string,
) {
	const job = updateJob(jobId, { phase, progress, message });
	if (job && progressWebhooks.shouldSend(jobId, phase, Date.now()))
		void sendWebhook(job);
}

interface PreparedSource {
	input: string;
	inputArgs: string[];
}

async function prepareSource(
	job: Job,
	request: ImportRequest,
	workDir: string,
	settings: ImporterSettings,
	jobSemaphore: Semaphore,
	signal: AbortSignal,
): Promise<PreparedSource> {
	const maxBytes = request.maxImportBytes ?? LOOM_IMPORT_MAX_BYTES;
	const allowedFetch = createAllowedFetch(settings.allowedHosts);
	assertAllowedSourceUrl(request.videoUrl, settings.allowedHosts);
	if (!isStreamingUrl(request.videoUrl)) {
		const sourcePath = join(workDir, "source.mp4");
		const result = await downloadUrlToPathParallel(
			request.videoUrl,
			sourcePath,
			{
				concurrency: settings.rangedConnections,
				partBytes: 8 * 1024 * 1024,
				signal,
				fetchImpl: withSizeLimit(allowedFetch, maxBytes),
			},
		);
		if (result.bytes > maxBytes)
			throw new Error("Loom imports are limited to 10 GB");
		return { input: sourcePath, inputArgs: [] };
	}
	const manifestDir = join(workDir, "manifest");
	const segmentDir = join(workDir, "segments");
	await mkdir(manifestDir);
	await mkdir(segmentDir);
	const master = await materializeStreamingInput(
		request.videoUrl,
		manifestDir,
		signal,
	);
	if (!master.endsWith(".m3u8"))
		throw new UnsupportedStreamError("This Loom DASH layout is not supported");
	const prefetched = await prefetchMaterializedHls(master, segmentDir, {
		fetchImpl: allowedFetch,
		signal,
		attempts: settings.segmentAttempts,
		requestTimeoutMs: settings.segmentTimeoutMs,
		jobSemaphore,
		globalSemaphore: settings.globalSemaphore,
		priority: request.importPriority === "customer",
		maxBytes,
		onProgress: (progress) => {
			if (
				progress.completedSegments % 50 === 0 ||
				progress.completedSegments === progress.totalSegments
			)
				progressUpdate(
					job.jobId,
					"downloading",
					Math.round(
						(progress.completedSegments / progress.totalSegments) * 60,
					),
					`Downloading from Loom (${progress.completedSegments}/${progress.totalSegments})...`,
				);
		},
	});
	return {
		input: prefetched.masterPath,
		inputArgs: PLAYLIST_INPUT_ARGS(await getFfmpegHlsCapabilities()),
	};
}

async function uploadPreviews(
	outputPath: string,
	metadata: VideoMetadata,
	request: ImportRequest,
	signal: AbortSignal,
) {
	const thumbnail = request.thumbnailPresignedUrl
		? generateThumbnail(outputPath, metadata.duration, {}, signal)
		: undefined;
	const gif: Promise<TempFileHandle> | undefined =
		request.previewGifPresignedUrl
			? generatePreviewGif(outputPath, metadata.duration, {}, signal)
			: undefined;
	thumbnail?.catch(() => {});
	gif?.catch(() => {});
	try {
		if (thumbnail && request.thumbnailPresignedUrl) {
			const data = await thumbnail;
			await uploadToS3(
				data,
				request.thumbnailPresignedUrl,
				"image/jpeg",
				signal,
			);
		}
	} catch (error) {
		signal.throwIfAborted();
		console.warn("[loom-importer] Thumbnail failed", error);
	}
	try {
		if (gif && request.previewGifPresignedUrl) {
			const rendered = await gif;
			try {
				await uploadFileToS3(
					rendered.path,
					request.previewGifPresignedUrl,
					"image/gif",
					signal,
				);
			} finally {
				await rendered.cleanup();
			}
		}
	} catch (error) {
		signal.throwIfAborted();
		console.warn("[loom-importer] Preview GIF failed", error);
	}
}

async function waitForDiskSpace(
	path: string,
	minFreeBytes: number,
	signal: AbortSignal,
) {
	while (true) {
		signal.throwIfAborted();
		const stats = await statfs(path).catch(() => null);
		if (!stats || stats.bavail * stats.bsize >= minFreeBytes) return;
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
}

export async function runLoomImport(
	job: Job,
	request: ImportRequest,
	settings: ImporterSettings,
	jobSemaphore: Semaphore,
	signal: AbortSignal,
): Promise<void> {
	const used = new Set<StorageUploadTarget>();
	const targets = [
		request.outputUpload,
		request.sourceUpload,
		request.originalUpload?.upload,
	].filter((target): target is StorageUploadTarget => target !== undefined);
	let workDir: string | undefined;
	try {
		await mkdir(settings.workRoot, { recursive: true });
		await waitForDiskSpace(settings.workRoot, settings.minFreeBytes, signal);
		workDir = await mkdtemp(join(settings.workRoot, `${request.videoId}-`));
		progressUpdate(job.jobId, "downloading", 0, "Downloading from Loom...");
		let outputPath: string;
		let deferredSourceKey: string | undefined;
		if (request.existingOutput) {
			outputPath = join(workDir, "result.mp4");
			await downloadUrlToPathParallel(request.existingOutput.url, outputPath, {
				concurrency: settings.rangedConnections,
				partBytes: 8 * 1024 * 1024,
				signal,
			});
		} else {
			const source = await prepareSource(
				job,
				request,
				workDir,
				settings,
				jobSemaphore,
				signal,
			);
			const codecs = await probeCodecs(source.inputArgs, source.input, signal);
			const container = chooseContainer(codecs);
			if (!container)
				throw new UnsupportedStreamError(
					`Loom source codecs are not supported (${codecs.video ?? "none"}/${codecs.audio ?? "none"})`,
				);
			if (container === "webm" && !request.originalUpload)
				throw new UnsupportedStreamError(
					"This Loom recording needs an original upload target",
				);
			progressUpdate(job.jobId, "processing", 65, "Packaging video...");
			outputPath = join(
				workDir,
				container === "mp4" ? "result.mp4" : "original.webm",
			);
			await runCommand(
				buildRemuxArgs(
					source.inputArgs,
					source.input,
					outputPath,
					container,
					codecs.audio !== null,
				),
				settings.remuxTimeoutMs,
				signal,
			);
			if (container === "webm") deferredSourceKey = request.originalUpload?.key;
		}
		const metadata = await probeOutput(outputPath, signal);
		if (metadata.fileSize > (request.maxImportBytes ?? LOOM_IMPORT_MAX_BYTES))
			throw new Error("Loom imports are limited to 10 GB");
		updateJob(job.jobId, { metadata });
		progressUpdate(job.jobId, "uploading", 75, "Saving video...");
		if (!request.existingOutput) {
			if (deferredSourceKey && request.originalUpload) {
				used.add(request.originalUpload.upload);
				await uploadFileToStorage(
					outputPath,
					request.originalUpload.upload,
					"video/webm",
					signal,
				);
			} else if (request.outputUpload) {
				used.add(request.outputUpload);
				await uploadFileToStorage(
					outputPath,
					request.outputUpload,
					"video/mp4",
					signal,
				);
			} else {
				await uploadFileToS3(
					outputPath,
					request.outputPresignedUrl,
					"video/mp4",
					signal,
				);
			}
		}
		await Promise.all(
			targets
				.filter((target) => !used.has(target))
				.map((target) => {
					used.add(target);
					return abortStorageUploadTarget(target).catch((error) =>
						console.warn("[loom-importer] Upload cleanup failed", error),
					);
				}),
		);
		progressUpdate(
			job.jobId,
			"generating_thumbnail",
			90,
			"Generating preview assets...",
		);
		await uploadPreviews(outputPath, metadata, request, signal);
		signal.throwIfAborted();
		const completed = updateJob(job.jobId, {
			phase: "complete",
			progress: 100,
			message: deferredSourceKey
				? "Imported original Loom video"
				: "Loom video imported",
			deferredSourceKey,
		});
		if (completed)
			await deliverTerminalWebhook(completed, settings.terminalWebhookAttempts);
	} catch (error) {
		await Promise.all(
			targets
				.filter((target) => !used.has(target))
				.map((target) => abortStorageUploadTarget(target).catch(() => {})),
		);
		const cancelled = signal.aborted;
		if (!cancelled) console.error(`[loom-importer] ${job.jobId} failed`, error);
		const failed = updateJob(job.jobId, {
			phase: cancelled ? "cancelled" : "error",
			progress: 0,
			error: cancelled
				? undefined
				: error instanceof Error
					? error.message
					: String(error),
			message: cancelled ? "Server shutting down" : "Loom import failed",
		});
		if (failed)
			await deliverTerminalWebhook(failed, settings.terminalWebhookAttempts);
	} finally {
		progressWebhooks.forget(job.jobId);
		if (workDir)
			await rm(workDir, { recursive: true, force: true }).catch(() => {});
	}
}
