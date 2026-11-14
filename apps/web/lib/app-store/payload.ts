import "server-only";

import type {
	CapPayload,
	CommentPayload,
	ConnectionPermission,
} from "@cap/app-store";
import { db } from "@cap/database";
import { comments, organizations, users, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { parseAgentVtt } from "@/lib/agent-api";
import { runPromise } from "@/lib/server";
import { videoShareUrl } from "@/lib/video-share-url";
import { decodeStorageVideo } from "@/lib/video-storage";

export const TRANSCRIPT_MAX_CHARACTERS = 200_000;
export const COMMENT_MAX_CHARACTERS = 4_000;

export type CapRecord = {
	video: typeof videos.$inferSelect;
	ownerName: string | null;
	organization: Pick<
		typeof organizations.$inferSelect,
		"id" | "customDomain" | "domainVerified" | "settings"
	> | null;
};

export async function loadCapRecord(
	videoId: Video.VideoId,
): Promise<CapRecord | null> {
	const [row] = await db()
		.select({
			video: videos,
			ownerName: users.name,
			organization: {
				id: organizations.id,
				customDomain: organizations.customDomain,
				domainVerified: organizations.domainVerified,
				settings: organizations.settings,
			},
		})
		.from(videos)
		.leftJoin(users, eq(users.id, videos.ownerId))
		.leftJoin(organizations, eq(organizations.id, videos.orgId))
		.where(eq(videos.id, videoId))
		.limit(1);
	if (!row) return null;
	return {
		video: row.video,
		ownerName: row.ownerName ?? null,
		organization: row.organization?.id ? row.organization : null,
	};
}

async function readTranscript(
	video: typeof videos.$inferSelect,
): Promise<string | null> {
	if (video.transcriptionStatus !== "COMPLETE") return null;
	const vtt = await Effect.gen(function* () {
		const [bucket] = yield* Storage.getAccessForVideo(
			decodeStorageVideo(video),
		);
		return yield* bucket.getObject(
			`${video.ownerId}/${video.id}/transcription.vtt`,
		);
	}).pipe(runPromise);
	if (Option.isNone(vtt)) return null;
	const text = parseAgentVtt(vtt.value)
		.map((cue) => cue.text)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return text.slice(0, TRANSCRIPT_MAX_CHARACTERS);
}

const disabled = (
	record: CapRecord,
	setting: "disableTranscript" | "disableSummary",
) =>
	record.video.settings?.[setting] ??
	record.organization?.settings?.[setting] ??
	false;

export async function buildCapPayload(
	record: CapRecord,
	permissions: readonly ConnectionPermission[],
): Promise<CapPayload> {
	const { video } = record;
	const payload: CapPayload = {
		id: video.id,
		title: video.name,
		url: videoShareUrl(serverEnv().WEB_URL, video.id, record.organization),
		ownerName: record.ownerName,
		organizationId: video.orgId ?? null,
		createdAt: video.createdAt.toISOString(),
		durationSeconds:
			typeof video.duration === "number" && Number.isFinite(video.duration)
				? Math.round(video.duration * 10) / 10
				: null,
	};

	if (permissions.includes("cap.transcript")) {
		payload.transcript = disabled(record, "disableTranscript")
			? null
			: await readTranscript(video).catch((error: unknown) => {
					console.error("[app-store] Could not read transcript", {
						videoId: video.id,
						message: error instanceof Error ? error.message : String(error),
					});
					return null;
				});
	}

	if (permissions.includes("cap.summary")) {
		const metadata = video.metadata;
		payload.summary = disabled(record, "disableSummary")
			? null
			: {
					title: metadata?.aiTitle ?? null,
					summary: metadata?.summary ?? null,
					chapters: (metadata?.chapters ?? []).map((chapter) => ({
						title: chapter.title,
						startSeconds: chapter.start,
					})),
				};
	}

	return payload;
}

export async function loadCommentPayload(
	commentId: string,
): Promise<CommentPayload | null> {
	const [row] = await db()
		.select({
			id: comments.id,
			content: comments.content,
			createdAt: comments.createdAt,
			timestamp: comments.timestamp,
			parentCommentId: comments.parentCommentId,
			authorName: users.name,
		})
		.from(comments)
		.leftJoin(users, eq(users.id, comments.authorId))
		.where(eq(comments.id, commentId as typeof comments.$inferSelect.id))
		.limit(1);
	if (!row) return null;
	return {
		id: row.id,
		text: row.content.slice(0, COMMENT_MAX_CHARACTERS),
		authorName: row.authorName ?? null,
		createdAt: row.createdAt.toISOString(),
		timestampSeconds: row.timestamp ?? null,
		parentCommentId: row.parentCommentId ?? null,
	};
}
