"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videoEdits, videos, videoUploads } from "@cap/database/schema";
import type { VideoEditSpec } from "@cap/database/types";
import { userIsPro } from "@cap/utils";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { revalidatePath } from "next/cache";
import { start } from "workflow/api";
import { runPromise } from "@/lib/server";
import { getEditSourceKey } from "@/lib/video-edit-processing";
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
	videoId,
	sourceKey,
}: {
	videoId: Video.VideoId;
	sourceKey: string;
}) {
	await db()
		.insert(videoUploads)
		.values({
			videoId,
			uploaded: 0,
			total: 0,
			mode: "singlepart",
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Starting video edit...",
			processingError: null,
			rawFileKey: sourceKey,
			updatedAt: new Date(),
		})
		.onDuplicateKeyUpdate({
			set: {
				uploaded: 0,
				total: 0,
				mode: "singlepart",
				phase: "processing",
				processingProgress: 0,
				processingMessage: "Starting video edit...",
				processingError: null,
				rawFileKey: sourceKey,
				updatedAt: new Date(),
			},
		});
}

async function loadEditableVideo(videoId: Video.VideoId) {
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

	if (activeUpload && ACTIVE_UPLOAD_PHASES.has(activeUpload.phase)) {
		const message =
			activeUpload.phase === "complete"
				? "Previous edit is finishing up. Try again in a moment."
				: activeUpload.phase === "error"
					? "Previous edit failed and is being cleaned up. Try again in a moment."
					: "Video is already uploading or processing";
		throw new Error(message);
	}

	return { user, video };
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

	const sourceKey = await ensureOriginalSourceCopy(
		video,
		existingEdit?.sourceKey,
	);
	const aiGenerationEnabled = await isAiGenerationEnabled(user);

	await markEditProcessing({ videoId, sourceKey });

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
			},
		]);
	} catch (error) {
		await db().delete(videoUploads).where(eq(videoUploads.videoId, videoId));
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
	const { user, video } = await loadEditableVideo(videoId);

	const [existingEdit] = await db()
		.select()
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId));

	if (!existingEdit) {
		revalidatePath(`/s/${videoId}/edit`);
		return { success: true, skipped: true };
	}

	const previousSpec = existingEdit.editSpec;
	const restoredSpec = createIdentityEditSpec(previousSpec.sourceDuration);

	if (getEditSpecOutputDuration(restoredSpec) <= 0) {
		throw new Error("Original video is no longer available");
	}

	if (areEditSpecsEquivalent(previousSpec, restoredSpec)) {
		revalidatePath(`/s/${videoId}/edit`);
		return { success: true, skipped: true };
	}

	const sourceKey = existingEdit.sourceKey;
	const bucket = await getVideoBucket(video);
	if (!(await objectExists(bucket, sourceKey))) {
		throw new Error("Original video is no longer available");
	}

	const aiGenerationEnabled = await isAiGenerationEnabled(user);

	await markEditProcessing({ videoId, sourceKey });

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
			},
		]);
	} catch (error) {
		await db().delete(videoUploads).where(eq(videoUploads.videoId, videoId));
		throw error instanceof Error
			? error
			: new Error("Video restore could not start");
	}

	revalidatePath(`/s/${videoId}`);
	revalidatePath(`/s/${videoId}/edit`);
	revalidatePath("/dashboard/caps");

	return { success: true };
}
