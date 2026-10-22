import { isDeepStrictEqual } from "node:util";
import { db } from "@cap/database";
import {
	videoProcessingJobs,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { FatalError } from "workflow";
import { z } from "zod";

export interface EditOperation {
	token: string;
	startedAt: string;
}

const stateSchema = z.object({
	token: z.string().uuid(),
	startedAt: z.string().datetime(),
	ownerId: z.string(),
	bucket: z.string().nullable(),
	storageIntegrationId: z.string().nullable(),
	sourceKey: z.string(),
	source: z.string(),
	dispatch: z.enum(["pending", "dispatching", "accepted"]),
	jobId: z.string().optional(),
	resultCommitted: z.boolean().optional(),
	renderedMetadata: z
		.object({
			duration: z.number().positive(),
			width: z.number().positive(),
			height: z.number().positive(),
			fps: z.number().positive(),
		})
		.optional(),
});
export type EditProcessingState = z.infer<typeof stateSchema>;
type Transaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

export function getEditProcessingState(metadata: VideoMetadata | null) {
	if (
		!metadata ||
		typeof metadata !== "object" ||
		!("editProcessing" in metadata)
	)
		return undefined;
	const parsed = stateSchema.safeParse(metadata.editProcessing);
	return parsed.success ? parsed.data : undefined;
}

export function withoutEditProcessing(metadata: VideoMetadata | null) {
	const next = { ...metadata };
	delete next.editProcessing;
	return next;
}

export function matchesEditOperation(
	video: Pick<
		typeof videos.$inferSelect,
		"metadata" | "source" | "ownerId" | "bucket" | "storageIntegrationId"
	>,
	upload:
		| Pick<typeof videoUploads.$inferSelect, "rawFileKey" | "startedAt">
		| undefined,
	sourceKey: string,
	operation: EditOperation,
) {
	const state = getEditProcessingState(video.metadata);
	if (!state) return false;
	let expectedSource: unknown;
	try {
		expectedSource = JSON.parse(state.source);
	} catch {
		return false;
	}
	return Boolean(
		upload &&
			state.token === operation.token &&
			state.startedAt === operation.startedAt &&
			state.ownerId === video.ownerId &&
			state.bucket === video.bucket &&
			state.storageIntegrationId === video.storageIntegrationId &&
			state.sourceKey === sourceKey &&
			isDeepStrictEqual(expectedSource, video.source) &&
			upload.rawFileKey === sourceKey &&
			upload.startedAt.toISOString() === operation.startedAt,
	);
}

export async function withEditOperation<T>(
	videoId: string,
	sourceKey: string,
	operation: EditOperation,
	run: (
		tx: Transaction,
		video: typeof videos.$inferSelect,
		upload: typeof videoUploads.$inferSelect,
		state: EditProcessingState,
	) => Promise<T>,
	lockRecordingJob = false,
): Promise<T> {
	return db().transaction(async (tx) => {
		if (lockRecordingJob) {
			await tx
				.select({ videoId: videoProcessingJobs.videoId })
				.from(videoProcessingJobs)
				.where(eq(videoProcessingJobs.videoId, videoId as Video.VideoId))
				.for("update");
		}
		const [video] = await tx
			.select()
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId))
			.for("update");
		const [upload] = await tx
			.select()
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId as Video.VideoId))
			.for("update");
		const state = getEditProcessingState(video?.metadata ?? null);
		if (
			!video ||
			!upload ||
			!state ||
			!matchesEditOperation(video, upload, sourceKey, operation)
		) {
			throw new FatalError("Edit operation has been replaced");
		}
		return run(tx, video, upload, state);
	});
}

export function getCompletedEdit(metadata: VideoMetadata | null) {
	if (
		!metadata ||
		typeof metadata !== "object" ||
		!("completedVideoEdit" in metadata)
	)
		return undefined;
	const parsed = z
		.object({
			token: z.string(),
			startedAt: z.string(),
			transcriptRemapped: z.boolean(),
		})
		.safeParse(metadata.completedVideoEdit);
	return parsed.success ? parsed.data : undefined;
}

export async function clearPendingEdit(
	videoId: string,
	sourceKey: string,
	operation: EditOperation,
): Promise<void> {
	await db().transaction(async (tx) => {
		const [video] = await tx
			.select()
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId))
			.for("update");
		const [upload] = await tx
			.select()
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId as Video.VideoId))
			.for("update");
		if (!video || !matchesEditOperation(video, upload, sourceKey, operation))
			return;
		const state = getEditProcessingState(video.metadata);
		if (state?.dispatch !== "pending") return;
		await tx
			.update(videos)
			.set({ metadata: withoutEditProcessing(video.metadata) })
			.where(eq(videos.id, video.id));
		await tx.delete(videoUploads).where(eq(videoUploads.videoId, video.id));
	});
}

export function getEditOutputKeys(
	ownerId: string,
	videoId: string,
	operation: EditOperation,
) {
	const prefix = `${ownerId}/${videoId}/.recording/outputs/edit-${operation.token}`;
	return {
		outputKey: `${prefix}/result.mp4`,
		thumbnailKey: `${prefix}/thumbnail.jpg`,
		previewKey: `${prefix}/preview.gif`,
	};
}

export async function clearFailedEdit(
	videoId: string,
	sourceKey: string,
	operation: EditOperation,
): Promise<void> {
	await db().transaction(async (tx) => {
		const [video] = await tx
			.select()
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId))
			.for("update");
		const [upload] = await tx
			.select()
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId as Video.VideoId))
			.for("update");
		if (!video || !matchesEditOperation(video, upload, sourceKey, operation))
			return;
		const state = getEditProcessingState(video.metadata);
		await tx
			.update(videos)
			.set({
				metadata: withoutEditProcessing(video.metadata),
				...(state?.resultCommitted ? { transcriptionStatus: null } : {}),
			})
			.where(eq(videos.id, video.id));
		await tx.delete(videoUploads).where(eq(videoUploads.videoId, video.id));
	});
}
