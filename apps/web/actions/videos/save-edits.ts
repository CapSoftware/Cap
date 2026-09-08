"use server";

import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videoEdits, videos, videoUploads } from "@cap/database/schema";
import type { VideoEditSpec } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { revalidatePath } from "next/cache";
import { start } from "workflow/api";
import { assertLegacyEditsQuiescent } from "@/lib/legacy-video-edit-recovery";
import { runPromise } from "@/lib/server";
import {
	clearPendingEdit,
	type EditOperation,
} from "@/lib/video-edit-operation";
import { getEditSourceKey, isEditSourceKey } from "@/lib/video-edit-processing";
import {
	areEditSpecsEquivalent,
	composeEditSpecs,
	createIdentityEditSpec,
	getEditSpecOutputDuration,
	normalizeKeepRanges,
} from "@/lib/video-edits";
import { decodeStorageVideo } from "@/lib/video-storage";
import { isAiGenerationEnabled } from "@/utils/flags";
import { editVideoWorkflow } from "@/workflows/edit-video";

const ACTIVE_UPLOAD_PHASES = new Set([
	"uploading",
	"processing",
	"generating_thumbnail",
	"complete",
	"error",
]);

function isMp4BackedVideo(source: typeof videos.$inferSelect.source) {
	return source.type === "desktopMP4" || source.type === "webMP4";
}

function getResultKey(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/result.mp4`;
}

async function objectExists(
	bucket: Awaited<ReturnType<typeof getVideoBucket>>,
	key: string,
) {
	return await bucket.headObject(key).pipe(
		Effect.as(true),
		Effect.catchAll(() => Effect.succeed(false)),
		runPromise,
	);
}

async function getVideoBucket(video: typeof videos.$inferSelect) {
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);
	return bucket;
}

async function ensureOriginalSourceCopy(
	video: typeof videos.$inferSelect,
	sourceKey = getEditSourceKey(video.ownerId, video.id),
) {
	const bucket = await getVideoBucket(video);
	const hasSource = await objectExists(bucket, sourceKey);

	if (!hasSource) {
		const resultKey = getResultKey(video.ownerId, video.id);
		await bucket
			.copyObject(`${bucket.bucketName}/${resultKey}`, sourceKey)
			.pipe(runPromise);
	}

	return sourceKey;
}

async function markEditProcessing({
	video,
	sourceKey,
	previousSpec,
	legacyUpload,
}: {
	video: typeof videos.$inferSelect;
	sourceKey: string;
	previousSpec: VideoEditSpec;
	legacyUpload?: typeof videoUploads.$inferSelect;
}): Promise<EditOperation> {
	const startedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
	const operation = { token: randomUUID(), startedAt: startedAt.toISOString() };
	await db().transaction(async (tx) => {
		const [current] = await tx
			.select()
			.from(videos)
			.where(eq(videos.id, video.id))
			.for("update");
		if (
			!current ||
			current.ownerId !== video.ownerId ||
			current.bucket !== video.bucket ||
			current.storageIntegrationId !== video.storageIntegrationId ||
			JSON.stringify(current.source) !== JSON.stringify(video.source)
		) {
			throw new Error("Video changed before the edit could start");
		}
		const [upload] = await tx
			.select()
			.from(videoUploads)
			.where(eq(videoUploads.videoId, video.id))
			.for("update");
		if (
			legacyUpload &&
			upload &&
			!current.metadata?.editProcessing &&
			upload.rawFileKey === legacyUpload.rawFileKey &&
			upload.startedAt.getTime() === legacyUpload.startedAt.getTime() &&
			upload.updatedAt.getTime() === legacyUpload.updatedAt.getTime() &&
			upload.phase === legacyUpload.phase
		) {
			await tx.delete(videoUploads).where(eq(videoUploads.videoId, video.id));
		} else if (upload || current.metadata?.editProcessing) {
			throw new Error("Video is already uploading or processing");
		}
		const [currentEdit] = await tx
			.select()
			.from(videoEdits)
			.where(eq(videoEdits.videoId, video.id))
			.for("update");
		if (
			!areEditSpecsEquivalent(
				currentEdit?.editSpec ??
					createIdentityEditSpec(
						current.duration ?? previousSpec.sourceDuration,
					),
				previousSpec,
			)
		) {
			throw new Error("Video edits changed before this edit could start");
		}
		await tx.insert(videoUploads).values({
			videoId: video.id,
			uploaded: 0,
			total: 0,
			mode: "singlepart",
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Starting video edit...",
			processingError: null,
			rawFileKey: sourceKey,
			startedAt,
			updatedAt: startedAt,
		});
		const metadata = {
			...(current.metadata ?? {}),
			editProcessing: {
				...operation,
				sourceKey,
				ownerId: current.ownerId,
				bucket: current.bucket,
				storageIntegrationId: current.storageIntegrationId,
				source: JSON.stringify(current.source),
				dispatch: "pending" as const,
			},
		};
		await tx.update(videos).set({ metadata }).where(eq(videos.id, video.id));
	});
	return operation;
}

async function loadEditableVideo(
	videoId: Video.VideoId,
	recoverLegacy = false,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	if (!userIsPro(user)) throw new Error("Cap Pro is required to edit videos");

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) throw new Error("Video not found");
	if (video.ownerId !== user.id) throw new Error("Forbidden");
	if (video.isScreenshot) throw new Error("Screenshots cannot be edited");
	if (!isMp4BackedVideo(video.source)) {
		throw new Error("Only processed MP4 videos can be edited");
	}

	const [activeUpload] = await db()
		.select()
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId));

	if (
		recoverLegacy &&
		activeUpload &&
		!video.metadata?.editProcessing &&
		isEditSourceKey({
			ownerId: video.ownerId,
			videoId,
			rawFileKey: activeUpload.rawFileKey,
		})
	) {
		if (
			!("workflowId" in editVideoWorkflow) ||
			typeof editVideoWorkflow.workflowId !== "string"
		) {
			throw new Error("The edit recovery runtime is unavailable");
		}
		await assertLegacyEditsQuiescent(editVideoWorkflow.workflowId);
		return { user, video, legacyUpload: activeUpload };
	}
	if (activeUpload && ACTIVE_UPLOAD_PHASES.has(activeUpload.phase)) {
		const message =
			activeUpload.phase === "complete"
				? "Previous edit is finishing up. Try again in a moment."
				: activeUpload.phase === "error"
					? "Previous edit failed and is being cleaned up. Try again in a moment."
					: "Video is already uploading or processing";
		throw new Error(message);
	}

	return { user, video, legacyUpload: undefined };
}

export async function saveVideoEdits(
	videoId: Video.VideoId,
	editSpec: VideoEditSpec,
) {
	const { user, video } = await loadEditableVideo(videoId);

	const [existingEdit] = await db()
		.select()
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId));

	const previousSpec =
		existingEdit?.editSpec ??
		createIdentityEditSpec(video.duration ?? editSpec.sourceDuration);
	const expectedCurrentDuration = existingEdit
		? getEditSpecOutputDuration(previousSpec)
		: (video.duration ?? editSpec.sourceDuration);
	const currentOutputSpec = normalizeKeepRanges(
		editSpec.keepRanges,
		expectedCurrentDuration,
	);

	if (getEditSpecOutputDuration(currentOutputSpec) <= 0) {
		throw new Error("Edit must keep at least one playable range");
	}

	const normalizedEditSpec = existingEdit
		? composeEditSpecs(previousSpec, currentOutputSpec)
		: currentOutputSpec;

	if (areEditSpecsEquivalent(previousSpec, normalizedEditSpec)) {
		revalidatePath(`/s/${videoId}/edit`);
		return { success: true, skipped: true };
	}

	const sourceKey =
		existingEdit?.sourceKey ?? getEditSourceKey(video.ownerId, video.id);
	const aiGenerationEnabled = await isAiGenerationEnabled(user);
	const operation = await markEditProcessing({
		video,
		sourceKey,
		previousSpec,
	});
	try {
		await ensureOriginalSourceCopy(video, sourceKey);
	} catch (error) {
		await clearPendingEdit(videoId, sourceKey, operation);
		throw error;
	}

	try {
		await start(editVideoWorkflow, [
			{
				videoId,
				userId: user.id,
				sourceKey,
				previousSpec,
				editSpec: normalizedEditSpec,
				keepRanges: normalizedEditSpec.keepRanges,
				aiGenerationEnabled,
				operation,
			},
		]);
	} catch (error) {
		await clearPendingEdit(videoId, sourceKey, operation);
		throw error instanceof Error
			? error
			: new Error("Video edit could not start");
	}

	revalidatePath(`/s/${videoId}`);
	revalidatePath(`/s/${videoId}/edit`);
	revalidatePath("/dashboard/caps");

	return { success: true };
}

export async function restoreVideoToOriginal(videoId: Video.VideoId) {
	const { user, video, legacyUpload } = await loadEditableVideo(videoId, true);

	const [existingEdit] = await db()
		.select()
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId));

	if (!existingEdit && !legacyUpload) {
		revalidatePath(`/s/${videoId}/edit`);
		return { success: true, skipped: true };
	}

	const sourceKey =
		existingEdit?.sourceKey ?? getEditSourceKey(video.ownerId, video.id);
	const bucket = await getVideoBucket(video);
	if (!(await objectExists(bucket, sourceKey)))
		throw new Error("Original video is no longer available");
	let sourceDuration =
		existingEdit?.editSpec.sourceDuration ?? video.duration ?? 0;
	if (legacyUpload) {
		const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
		if (!mediaServerUrl)
			throw new Error("Video recovery is temporarily unavailable");
		const sourceUrl = await bucket
			.getInternalSignedObjectUrl(sourceKey, { expiresIn: 300 })
			.pipe(runPromise);
		const response = await fetch(`${mediaServerUrl}/video/probe`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-media-server-secret": serverEnv().MEDIA_SERVER_WEBHOOK_SECRET ?? "",
			},
			body: JSON.stringify({ videoUrl: sourceUrl }),
			signal: AbortSignal.timeout(30_000),
		});
		const result: unknown = await response.json();
		if (
			!response.ok ||
			!result ||
			typeof result !== "object" ||
			!("metadata" in result) ||
			!result.metadata ||
			typeof result.metadata !== "object" ||
			!("duration" in result.metadata) ||
			typeof result.metadata.duration !== "number" ||
			!Number.isFinite(result.metadata.duration) ||
			result.metadata.duration <= 0
		) {
			throw new Error("The original video could not be verified for recovery");
		}
		sourceDuration = result.metadata.duration;
	}
	const previousSpec =
		existingEdit?.editSpec ??
		createIdentityEditSpec(video.duration ?? sourceDuration);
	const restoredSpec = createIdentityEditSpec(sourceDuration);
	if (getEditSpecOutputDuration(restoredSpec) <= 0)
		throw new Error("Original video is no longer available");
	if (!legacyUpload && areEditSpecsEquivalent(previousSpec, restoredSpec)) {
		revalidatePath(`/s/${videoId}/edit`);
		return { success: true, skipped: true };
	}

	const aiGenerationEnabled = await isAiGenerationEnabled(user);

	const operation = await markEditProcessing({
		video,
		sourceKey,
		previousSpec,
		legacyUpload,
	});

	try {
		await start(editVideoWorkflow, [
			{
				videoId,
				userId: user.id,
				sourceKey,
				previousSpec,
				editSpec: restoredSpec,
				keepRanges: restoredSpec.keepRanges,
				aiGenerationEnabled,
				operation,
			},
		]);
	} catch (error) {
		await clearPendingEdit(videoId, sourceKey, operation);
		throw error instanceof Error
			? error
			: new Error("Video restore could not start");
	}

	revalidatePath(`/s/${videoId}`);
	revalidatePath(`/s/${videoId}/edit`);
	revalidatePath("/dashboard/caps");

	return { success: true };
}
