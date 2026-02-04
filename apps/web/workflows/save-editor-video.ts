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

	const response = await fetch(`${mediaServerUrl}/video/editor/process`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			videoId: payload.videoId,
			userId: payload.userId,
			videoUrl: sourceUrl,
			outputPresignedUrl,
			projectConfig: payload.config,
		}),
	});

	if (!response.ok) {
		const errorData = await response.json().catch(() => ({}));
		throw new Error(
			(errorData as { error?: string }).error ||
				"Editor render failed to start",
		);
	}

	const { jobId } = (await response.json()) as { jobId: string };

	return await pollForCompletion(mediaServerUrl, jobId);
}

async function pollForCompletion(
	mediaServerUrl: string,
	jobId: string,
): Promise<MediaServerProcessResult> {
	const maxAttempts = 360;
	const pollIntervalMs = 5000;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

		const response = await fetch(
			`${mediaServerUrl}/video/editor/process/${jobId}/status`,
			{
				method: "GET",
				headers: { Accept: "application/json" },
			},
		);

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
	}

	throw new Error("Editor render timed out");
}
