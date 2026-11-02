"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { users, videoHighlights, videos } from "@cap/database/schema";
import { provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { count, eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { revalidatePath } from "next/cache";
import * as EffectRuntime from "@/lib/server";
import {
	canManageHighlight,
	HIGHLIGHTS_PER_VIDEO_LIMIT,
	normalizeHighlightLabel,
	normalizeHighlightTimestamp,
	type VideoHighlight,
} from "@/lib/video-highlights";

async function requireUser() {
	const user = await getCurrentUser();
	if (!user) throw new Error("User not authenticated");
	return user;
}

async function loadViewableVideo(videoId: Video.VideoId) {
	const accessExit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;
		return yield* Effect.promise(() =>
			db()
				.select({
					id: videos.id,
					ownerId: videos.ownerId,
					duration: videos.duration,
				})
				.from(videos)
				.where(eq(videos.id, videoId))
				.limit(1),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(accessExit)) throw new Error("Video not found");
	const [video] = accessExit.value;
	if (!video) throw new Error("Video not found");
	return video;
}

async function loadManageableHighlight(highlightId: string, userId: string) {
	const [row] = await db()
		.select({
			id: videoHighlights.id,
			videoId: videoHighlights.videoId,
			authorId: videoHighlights.authorId,
			ownerId: videos.ownerId,
		})
		.from(videoHighlights)
		.innerJoin(videos, eq(videoHighlights.videoId, videos.id))
		.where(eq(videoHighlights.id, highlightId))
		.limit(1);

	if (
		!row ||
		!canManageHighlight({
			viewerId: userId,
			authorId: row.authorId,
			ownerId: row.ownerId,
		})
	) {
		throw new Error(
			"Highlight not found or you don't have permission to change it",
		);
	}

	await loadViewableVideo(row.videoId);
	return row;
}

export async function createHighlight(data: {
	videoId: Video.VideoId;
	timestamp: number;
	label?: string | null;
}): Promise<VideoHighlight> {
	const user = await requireUser();
	if (!data.videoId) throw new Error("videoId is required");

	const video = await loadViewableVideo(data.videoId);
	const timestamp = normalizeHighlightTimestamp(data.timestamp, video.duration);
	if (timestamp === null) throw new Error("Invalid timestamp");

	const [existing] = await db()
		.select({ total: count() })
		.from(videoHighlights)
		.where(eq(videoHighlights.videoId, video.id))
		.limit(1);
	if ((existing?.total ?? 0) >= HIGHLIGHTS_PER_VIDEO_LIMIT) {
		throw new Error("This video has reached its highlight limit");
	}

	const now = new Date();
	const highlight = {
		id: nanoId(),
		videoId: video.id,
		authorId: user.id,
		timestamp,
		label: normalizeHighlightLabel(data.label),
		createdAt: now,
		updatedAt: now,
	};

	await db().insert(videoHighlights).values(highlight);
	revalidatePath(`/s/${video.id}`);

	return { ...highlight, authorName: user.name };
}

export async function renameHighlight(data: {
	highlightId: string;
	label: string | null;
}): Promise<{ id: string; label: string | null }> {
	const user = await requireUser();
	const row = await loadManageableHighlight(data.highlightId, user.id);
	const label = normalizeHighlightLabel(data.label);

	await db()
		.update(videoHighlights)
		.set({ label })
		.where(eq(videoHighlights.id, row.id));
	revalidatePath(`/s/${row.videoId}`);

	return { id: row.id, label };
}

export async function deleteHighlight(data: {
	highlightId: string;
}): Promise<{ success: true }> {
	const user = await requireUser();
	const row = await loadManageableHighlight(data.highlightId, user.id);

	await db().delete(videoHighlights).where(eq(videoHighlights.id, row.id));
	revalidatePath(`/s/${row.videoId}`);

	return { success: true };
}

export async function getVideoHighlights(
	videoId: Video.VideoId,
): Promise<VideoHighlight[]> {
	await loadViewableVideo(videoId);
	return db()
		.select({
			id: videoHighlights.id,
			videoId: videoHighlights.videoId,
			authorId: videoHighlights.authorId,
			timestamp: videoHighlights.timestamp,
			label: videoHighlights.label,
			authorName: users.name,
			createdAt: videoHighlights.createdAt,
			updatedAt: videoHighlights.updatedAt,
		})
		.from(videoHighlights)
		.leftJoin(users, eq(videoHighlights.authorId, users.id))
		.where(eq(videoHighlights.videoId, videoId))
		.orderBy(videoHighlights.timestamp, videoHighlights.id);
}
