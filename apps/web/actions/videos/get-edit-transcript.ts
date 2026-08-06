"use server";

import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videoEdits, videos } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Option } from "effect";
import { start } from "workflow/api";
import {
	type EditTranscript,
	type EditTranscriptBackfillStatus,
	getEditTranscriptBackfillStatus,
	getEditTranscriptObjectKey,
	parseEditTranscript,
	remapEditTranscriptThroughSpec,
} from "@/lib/edit-transcript";
import { decryptEditTranscriptObject } from "@/lib/edit-transcript-storage";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";
import { backfillEditTranscriptWorkflow } from "@/workflows/transcribe";

type EditTranscriptResponse =
	| { status: "ready"; transcript: EditTranscript }
	| { status: "missing" }
	| { status: "processing" }
	| { status: "error"; message: string };

const BACKFILL_STALE_AFTER_MS = 60 * 60 * 1000;
const PUBLIC_ERROR_MESSAGES = new Set([
	"Unauthorized",
	"Cap Pro is required",
	"Video not found",
	"Transcript editing is not available for this video",
	"Transcript is not ready",
]);

function isMp4BackedVideo(source: typeof videos.$inferSelect.source) {
	return source.type === "desktopMP4" || source.type === "webMP4";
}

function isEditableTranscriptVideo(video: typeof videos.$inferSelect) {
	return (
		video.transcriptionStatus === "COMPLETE" &&
		!video.isScreenshot &&
		isMp4BackedVideo(video.source) &&
		Boolean(video.duration && video.duration > 0)
	);
}

function getPublicErrorMessage(error: unknown, fallback: string) {
	return isPublicError(error) ? error.message : fallback;
}

function isPublicError(error: unknown): error is Error {
	return error instanceof Error && PUBLIC_ERROR_MESSAGES.has(error.message);
}

async function loadEditableTranscriptVideo(videoId: Video.VideoId) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	if (!userIsPro(user)) throw new Error("Cap Pro is required");

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));
	if (!video || video.ownerId !== user.id) throw new Error("Video not found");
	if (!isEditableTranscriptVideo(video)) {
		if (video.transcriptionStatus !== "COMPLETE") {
			throw new Error("Transcript is not ready");
		}
		throw new Error("Transcript editing is not available for this video");
	}

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	return { user, video, bucket };
}

async function getOptionalObject(
	bucket: Awaited<ReturnType<typeof loadEditableTranscriptVideo>>["bucket"],
	key: string,
) {
	const object = await bucket.getObject(key).pipe(runPromise);
	return Option.isSome(object) ? object.value : null;
}

function isFreshProcessingStatus(status: EditTranscriptBackfillStatus) {
	if (status.status !== "processing") return false;
	const requestedAt = Date.parse(status.requestedAt);
	return (
		Number.isFinite(requestedAt) &&
		Date.now() - requestedAt < BACKFILL_STALE_AFTER_MS
	);
}

function isDurationCurrent(durationMs: number, expectedSeconds: number) {
	return Math.abs(durationMs - Math.round(expectedSeconds * 1000)) <= 250;
}

/**
 * Reads the stored word transcript. Stored words always describe the ORIGINAL
 * media, so for edited videos they are checked against the edit spec's source
 * duration and remapped onto the current output timeline before being returned.
 */
async function readCurrentEditTranscript(
	bucket: Awaited<ReturnType<typeof loadEditableTranscriptVideo>>["bucket"],
	video: typeof videos.$inferSelect,
): Promise<EditTranscript | null> {
	const content = await getOptionalObject(
		bucket,
		getEditTranscriptObjectKey(video.ownerId, video.id),
	);
	const decrypted = content
		? decryptEditTranscriptObject(content, video.ownerId, video.id)
		: null;
	const transcript = decrypted ? parseEditTranscript(decrypted) : null;
	if (!transcript) return null;

	const [edit] = await db()
		.select({ editSpec: videoEdits.editSpec })
		.from(videoEdits)
		.where(eq(videoEdits.videoId, video.id));

	if (!edit?.editSpec) {
		return isDurationCurrent(transcript.durationMs, video.duration ?? 0)
			? transcript
			: null;
	}

	return isDurationCurrent(transcript.durationMs, edit.editSpec.sourceDuration)
		? remapEditTranscriptThroughSpec(transcript, edit.editSpec)
		: null;
}

export async function getEditTranscript(
	videoId: Video.VideoId,
): Promise<EditTranscriptResponse> {
	try {
		const { video, bucket } = await loadEditableTranscriptVideo(videoId);
		const transcript = await readCurrentEditTranscript(bucket, video);

		if (transcript) {
			return { status: "ready", transcript };
		}

		const status = getEditTranscriptBackfillStatus(video.metadata);
		if (status && isFreshProcessingStatus(status)) {
			return { status: "processing" };
		}
		if (status?.status === "processing") {
			return {
				status: "error",
				message: "Transcript preparation stalled. Try again.",
			};
		}
		if (status?.status === "error") {
			return {
				status: "error",
				message: "Transcript preparation failed. Try again.",
			};
		}
		return { status: "missing" };
	} catch (error) {
		if (!isPublicError(error)) {
			console.error(
				`[editTranscript] Failed to load transcript for ${videoId}`,
				error,
			);
		}
		return {
			status: "error",
			message: getPublicErrorMessage(error, "Transcript unavailable"),
		};
	}
}

async function claimEditTranscriptBackfill(
	videoId: Video.VideoId,
	userId: string,
) {
	return db().transaction(async (tx) => {
		const [video] = await tx
			.select()
			.from(videos)
			.where(eq(videos.id, videoId))
			.for("update");
		if (!video || video.ownerId !== userId) throw new Error("Video not found");
		if (!isEditableTranscriptVideo(video)) {
			throw new Error("Transcript editing is not available for this video");
		}

		const existing = getEditTranscriptBackfillStatus(video.metadata);
		if (existing && isFreshProcessingStatus(existing)) {
			return { claimed: false as const };
		}

		const requestId = randomUUID();
		const status = {
			status: "processing",
			requestId,
			requestedAt: new Date().toISOString(),
		};
		await tx
			.update(videos)
			.set({
				metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.editTranscriptBackfill', CAST(${JSON.stringify(status)} AS JSON))`,
				updatedAt: video.updatedAt,
			})
			.where(eq(videos.id, videoId));

		return { claimed: true as const, requestId };
	});
}

async function setEditTranscriptBackfillError(
	videoId: Video.VideoId,
	requestId: string,
) {
	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.editTranscriptBackfill.status', 'error')`,
			updatedAt: sql`${videos.updatedAt}`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.editTranscriptBackfill.requestId')) = ${requestId}`,
			),
		);
}

async function clearEditTranscriptBackfill(
	videoId: Video.VideoId,
	requestId: string,
) {
	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_REMOVE(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.editTranscriptBackfill')`,
			updatedAt: sql`${videos.updatedAt}`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.editTranscriptBackfill.requestId')) = ${requestId}`,
			),
		);
}

export async function requestEditTranscript(
	videoId: Video.VideoId,
): Promise<EditTranscriptResponse> {
	try {
		const { user, video, bucket } = await loadEditableTranscriptVideo(videoId);
		const transcript = await readCurrentEditTranscript(bucket, video);
		if (transcript) {
			return { status: "ready", transcript };
		}

		const claim = await claimEditTranscriptBackfill(videoId, user.id);
		if (!claim.claimed) {
			return { status: "processing" };
		}

		const transcriptAfterClaim = await readCurrentEditTranscript(bucket, video);
		if (transcriptAfterClaim) {
			await clearEditTranscriptBackfill(videoId, claim.requestId);
			return { status: "ready", transcript: transcriptAfterClaim };
		}

		try {
			await start(backfillEditTranscriptWorkflow, [
				{
					videoId,
					userId: user.id,
					requestId: claim.requestId,
				},
			]);
		} catch (error) {
			console.error(
				`[editTranscript] Failed to start backfill for ${videoId}`,
				error,
			);
			await setEditTranscriptBackfillError(videoId, claim.requestId);
			return {
				status: "error",
				message: "Transcript preparation could not start. Try again.",
			};
		}

		return { status: "processing" };
	} catch (error) {
		if (!isPublicError(error)) {
			console.error(
				`[editTranscript] Failed to request transcript for ${videoId}`,
				error,
			);
		}
		return {
			status: "error",
			message: getPublicErrorMessage(error, "Transcript unavailable"),
		};
	}
}
