import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { FatalError } from "workflow";
import type { ProjectConfiguration } from "@/app/editor/types/project-config";
import {
	createEditorSavedRenderState,
	type EditorSavedRenderState,
} from "@/lib/editor-saved-render";
import { runPromise } from "@/lib/server";

interface SaveEditorVideoWorkflowPayload {
	videoId: string;
	userId: string;
	bucketId: string | null;
	sourceKey: string;
	outputKey: string;
	config: ProjectConfiguration;
	cameraKey?: string;
}

interface MediaServerProcessResult {
	metadata: {
		duration: number;
		width: number;
		height: number;
		fps: number;
		videoCodec: string;
		audioCodec: string | null;
		audioChannels: number | null;
		sampleRate: number | null;
		bitrate: number;
		fileSize: number;
	};
	progress: number;
	message?: string;
}

interface MediaServerEditorProcessPayload {
	videoId: string;
	userId: string;
	videoUrl: string;
	cameraUrl?: string;
	outputPresignedUrl: string;
	projectConfig: ProjectConfiguration;
}

interface MediaServerStartResult {
	jobId?: string;
	notFoundErrorMessage?: string;
}

interface MediaServerStartAndPollResult {
	result?: MediaServerProcessResult;
	notFoundErrorMessage?: string;
}

const editorProcessPathCandidates = [
	"/video/editor/process",
	"/editor/process",
] as const;
const POLL_MAX_ATTEMPTS = 360;
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_CONSECUTIVE_CONNECTION_FAILURES = 3;
const POLL_STALLED_TIMEOUT_MS = 120_000;
const POLL_STALLED_NEAR_COMPLETE_TIMEOUT_MS = 10 * 60 * 1000;

function joinMediaServerUrl(baseUrl: string, path: string): string {
	const trimmedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	return `${trimmedBase}${normalizedPath}`;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return String(error);
}

function isLoopbackHost(hostname: string): boolean {
	return (
		hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
	);
}

function isPresignedStorageUrl(parsed: URL): boolean {
	const presignedParams = [
		"x-amz-algorithm",
		"x-amz-credential",
		"x-amz-signature",
		"x-amz-date",
		"x-amz-expires",
		"awsaccesskeyid",
		"signature",
		"expires",
	];
	const keys = new Set(
		Array.from(parsed.searchParams.keys()).map((key) => key.toLowerCase()),
	);

	return presignedParams.some((param) => keys.has(param));
}

function maybeRewriteLoopbackUrlForMediaServer(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return value;
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return value;
	}

	if (!isLoopbackHost(parsed.hostname)) {
		return value;
	}

	if (isPresignedStorageUrl(parsed)) {
		return value;
	}

	parsed.hostname = "host.docker.internal";
	return parsed.toString();
}

function rewriteLoopbackUrlsForMediaServer<T>(value: T): T {
	if (typeof value === "string") {
		return maybeRewriteLoopbackUrlForMediaServer(value) as T;
	}

	if (Array.isArray(value)) {
		return value.map((item) => rewriteLoopbackUrlsForMediaServer(item)) as T;
	}

	if (value && typeof value === "object") {
		const rewrittenEntries = Object.entries(
			value as Record<string, unknown>,
		).map(([key, entryValue]) => [
			key,
			rewriteLoopbackUrlsForMediaServer(entryValue),
		]);

		return Object.fromEntries(rewrittenEntries) as T;
	}

	return value;
}

function shouldRetryWithLoopbackRewrite(error: unknown): boolean {
	return getErrorMessage(error).includes(
		"Unable to connect. Is the computer able to access the url?",
	);
}

function getEncodingProgress(message: string | undefined): number | null {
	if (!message) {
		return null;
	}

	const match = message.match(/encoding:\s*(\d{1,3})%/i);
	if (!match) {
		return null;
	}

	const value = Number.parseInt(match[1] ?? "", 10);
	if (!Number.isFinite(value)) {
		return null;
	}

	return Math.min(100, Math.max(0, value));
}

function createMediaServerConnectionError(
	mediaServerUrl: string,
	path: string,
	error: unknown,
): FatalError {
	const endpoint = joinMediaServerUrl(mediaServerUrl, path);
	return new FatalError(
		`Unable to connect to media server at ${endpoint}. Check MEDIA_SERVER_URL (${mediaServerUrl}) and that the media server is running and reachable. ${getErrorMessage(error)}`,
	);
}

async function readMediaServerErrorMessage(
	response: Response,
	fallbackMessage: string,
): Promise<string> {
	const statusLabel = `status ${response.status}${
		response.statusText ? ` ${response.statusText}` : ""
	}`;
	const responseText = await response.text().catch(() => "");

	if (responseText) {
		try {
			const parsed = JSON.parse(responseText) as {
				error?: unknown;
				details?: unknown;
				code?: unknown;
			};
			const error =
				typeof parsed.error === "string" ? parsed.error.trim() : undefined;
			const details =
				typeof parsed.details === "string" ? parsed.details.trim() : undefined;
			const code =
				typeof parsed.code === "string" ? parsed.code.trim() : undefined;

			if (error && details && code) {
				return `${fallbackMessage} (${statusLabel}, code ${code}): ${error} (${details})`;
			}

			if (error && details) {
				return `${fallbackMessage} (${statusLabel}): ${error} (${details})`;
			}

			if (error && code) {
				return `${fallbackMessage} (${statusLabel}, code ${code}): ${error}`;
			}

			if (error) {
				return `${fallbackMessage} (${statusLabel}): ${error}`;
			}
		} catch {}

		return `${fallbackMessage} (${statusLabel}): ${responseText.slice(0, 500)}`;
	}

	return `${fallbackMessage} (${statusLabel})`;
}

export async function saveEditorVideoWorkflow(
	payload: SaveEditorVideoWorkflowPayload,
) {
	"use workflow";

	const video = await validateVideo(payload);

	let renderState: EditorSavedRenderState = createEditorSavedRenderState({
		status: "PROCESSING",
		sourceKey: payload.sourceKey,
		outputKey: payload.outputKey,
		progress: 0,
		message: "Preparing saved changes...",
		error: null,
		requestedAt:
			((video.metadata as VideoMetadata | null | undefined)?.editorSavedRender
				?.requestedAt as string | undefined) ?? new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});

	await persistRenderState(payload.videoId, renderState);

	try {
		renderState = createEditorSavedRenderState({
			...renderState,
			status: "PROCESSING",
			progress: 0,
			message: "Rendering saved changes...",
			error: null,
			updatedAt: new Date().toISOString(),
		});

		await persistRenderState(payload.videoId, renderState);

		const result = await processOnMediaServer(payload);

		renderState = createEditorSavedRenderState({
			...renderState,
			status: "COMPLETE",
			progress: 100,
			message: "Saved changes ready",
			error: null,
			updatedAt: new Date().toISOString(),
		});

		await persistRenderState(payload.videoId, renderState, result.metadata);

		return {
			success: true,
			message: "Saved editor render completed",
		};
	} catch (error) {
		renderState = createEditorSavedRenderState({
			...renderState,
			status: "ERROR",
			message: "Failed to render saved changes",
			error: error instanceof Error ? error.message : String(error),
			updatedAt: new Date().toISOString(),
		});

		await persistRenderState(payload.videoId, renderState);

		throw error;
	}
}

async function validateVideo(payload: SaveEditorVideoWorkflowPayload) {
	"use step";

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}

	const [video] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			metadata: videos.metadata,
		})
		.from(videos)
		.where(eq(videos.id, payload.videoId as Video.VideoId));

	if (!video) {
		throw new FatalError("Video does not exist");
	}

	if (video.ownerId !== payload.userId) {
		throw new FatalError("Unauthorized");
	}

	return video;
}

async function persistRenderState(
	videoId: string,
	renderState: EditorSavedRenderState,
	metadata?: {
		duration: number;
		width: number;
		height: number;
		fps: number;
		videoCodec: string;
		audioCodec: string | null;
		audioChannels: number | null;
		sampleRate: number | null;
		bitrate: number;
		fileSize: number;
	},
): Promise<void> {
	"use step";

	const [video] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);

	if (!video) {
		throw new FatalError("Video does not exist");
	}

	const currentMetadata = (video.metadata as VideoMetadata | null) || {};

	await db()
		.update(videos)
		.set({
			metadata: {
				...currentMetadata,
				editorSavedRender: renderState,
			},
			...(metadata
				? {
						width: metadata.width,
						height: metadata.height,
						duration: metadata.duration,
					}
				: {}),
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function processOnMediaServer(
	payload: SaveEditorVideoWorkflowPayload,
): Promise<MediaServerProcessResult> {
	"use step";

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}

	const [bucket] = await S3Buckets.getBucketAccess(
		Option.fromNullable(payload.bucketId as S3Bucket.S3BucketId | null),
	).pipe(runPromise);

	const sourceUrl = await bucket
		.getInternalSignedObjectUrl(payload.sourceKey)
		.pipe(runPromise);

	const outputPresignedUrl = await bucket
		.getInternalPresignedPutUrl(payload.outputKey, {
			ContentType: "video/mp4",
		})
		.pipe(runPromise);

	let cameraUrl: string | undefined;
	if (payload.cameraKey) {
		try {
			cameraUrl = await bucket
				.getInternalSignedObjectUrl(payload.cameraKey)
				.pipe(runPromise);
		} catch (err) {
			console.error(
				"[saveEditorVideo] Failed to get camera URL, rendering without camera:",
				err,
			);
		}
	}

	const processPayload: MediaServerEditorProcessPayload = {
		videoId: payload.videoId,
		userId: payload.userId,
		videoUrl: sourceUrl,
		...(cameraUrl ? { cameraUrl } : {}),
		outputPresignedUrl,
		projectConfig: payload.config,
	};
	const requestBody = JSON.stringify(processPayload);
	const rewrittenProcessPayload =
		rewriteLoopbackUrlsForMediaServer(processPayload);
	const rewrittenRequestBody = JSON.stringify(rewrittenProcessPayload);
	const canRetryWithRewrittenLoopbackUrls =
		rewrittenRequestBody !== requestBody;

	let notFoundErrorMessage: string | null = null;

	for (const processPath of editorProcessPathCandidates) {
		try {
			const primaryResult = await startAndPollEditorProcess(
				mediaServerUrl,
				processPath,
				requestBody,
			);

			if (primaryResult.notFoundErrorMessage) {
				notFoundErrorMessage = primaryResult.notFoundErrorMessage;
				continue;
			}

			if (primaryResult.result) {
				return primaryResult.result;
			}

			throw new FatalError("Editor render failed to start");
		} catch (error) {
			if (
				!canRetryWithRewrittenLoopbackUrls ||
				!shouldRetryWithLoopbackRewrite(error)
			) {
				throw error;
			}

			const rewrittenResult = await startAndPollEditorProcess(
				mediaServerUrl,
				processPath,
				rewrittenRequestBody,
			);

			if (rewrittenResult.notFoundErrorMessage) {
				notFoundErrorMessage = rewrittenResult.notFoundErrorMessage;
				continue;
			}

			if (rewrittenResult.result) {
				return rewrittenResult.result;
			}

			throw new FatalError("Editor render failed to start");
		}
	}

	if (notFoundErrorMessage) {
		throw new FatalError(
			`${notFoundErrorMessage}. Check MEDIA_SERVER_URL (${mediaServerUrl}) and media-server version.`,
		);
	}

	throw new FatalError("Editor render failed to start");
}

async function startAndPollEditorProcess(
	mediaServerUrl: string,
	processPath: string,
	requestBody: string,
): Promise<MediaServerStartAndPollResult> {
	const startResult = await startEditorProcess(
		mediaServerUrl,
		processPath,
		requestBody,
	);

	if (startResult.notFoundErrorMessage) {
		return { notFoundErrorMessage: startResult.notFoundErrorMessage };
	}

	const jobId = startResult.jobId;
	if (!jobId) {
		throw new FatalError("Editor render failed to start");
	}

	return {
		result: await pollForCompletion(mediaServerUrl, processPath, jobId),
	};
}

async function pollForCompletion(
	mediaServerUrl: string,
	processPath: string,
	jobId: string,
): Promise<MediaServerProcessResult> {
	let consecutiveConnectionFailures = 0;
	let lastStatusSignature = "";
	let lastStatusChangedAt = Date.now();

	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

		const statusPath = `${processPath}/${jobId}/status`;
		let response: Response;
		try {
			response = await fetch(joinMediaServerUrl(mediaServerUrl, statusPath), {
				method: "GET",
				headers: { Accept: "application/json" },
			});
		} catch (error) {
			consecutiveConnectionFailures += 1;
			if (
				consecutiveConnectionFailures >=
				POLL_MAX_CONSECUTIVE_CONNECTION_FAILURES
			) {
				throw createMediaServerConnectionError(
					mediaServerUrl,
					statusPath,
					error,
				);
			}
			continue;
		}

		consecutiveConnectionFailures = 0;

		if (!response.ok) {
			continue;
		}

		const status = (await response.json()) as {
			phase: string;
			progress: number;
			message?: string;
			error?: string;
			metadata?: MediaServerProcessResult["metadata"];
		};

		if (status.phase === "complete") {
			if (!status.metadata) {
				throw new Error("Editor render completed without metadata");
			}
			return {
				metadata: status.metadata,
				progress: status.progress,
				message: status.message,
			};
		}

		if (status.phase === "error") {
			throw new Error(status.error || "Editor render failed");
		}

		if (status.phase === "cancelled") {
			throw new Error("Editor render was cancelled");
		}

		const progressValue = Number.isFinite(status.progress)
			? status.progress
			: 0;
		const encodingProgress = getEncodingProgress(status.message);
		const statusSignature = `${status.phase}:${Math.round(progressValue * 1000)}:${status.message ?? ""}`;

		if (statusSignature !== lastStatusSignature) {
			lastStatusSignature = statusSignature;
			lastStatusChangedAt = Date.now();
			continue;
		}

		const isNearComplete =
			encodingProgress !== null
				? encodingProgress >= 98
				: status.phase === "uploading" || progressValue >= 99;
		const stallTimeoutMs = isNearComplete
			? POLL_STALLED_NEAR_COMPLETE_TIMEOUT_MS
			: POLL_STALLED_TIMEOUT_MS;

		if (Date.now() - lastStatusChangedAt >= stallTimeoutMs) {
			throw new Error(
				`Editor render stalled at ${status.phase} (${Math.round(progressValue)}%)`,
			);
		}
	}

	throw new Error("Editor render timed out");
}

async function startEditorProcess(
	mediaServerUrl: string,
	processPath: string,
	requestBody: string,
): Promise<MediaServerStartResult> {
	const requestUrl = joinMediaServerUrl(mediaServerUrl, processPath);

	let response: Response;
	try {
		response = await fetch(requestUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: requestBody,
		});
	} catch (error) {
		throw createMediaServerConnectionError(mediaServerUrl, processPath, error);
	}

	if (response.ok) {
		const { jobId } = (await response.json()) as { jobId: string };
		return { jobId };
	}

	const errorMessage = await readMediaServerErrorMessage(
		response,
		"Editor render failed to start",
	);

	if (response.status === 404) {
		return { notFoundErrorMessage: errorMessage };
	}

	if (
		response.status >= 400 &&
		response.status < 500 &&
		response.status !== 429
	) {
		throw new FatalError(errorMessage);
	}

	throw new Error(errorMessage);
}
