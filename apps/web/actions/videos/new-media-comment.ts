"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { comments } from "@cap/database/schema";
import {
	provideOptionalAuth,
	Storage,
	VideosPolicy,
	VideosRepo,
	verifyCommentMediaUploadToken,
} from "@cap/web-backend";
import type { ImageUpload, Video } from "@cap/web-domain";
import { type Comment, Policy } from "@cap/web-domain";
import { Effect, Exit, Option } from "effect";
import { revalidatePath } from "next/cache";
import { sanitizeWaveform } from "@/lib/comment-media";
import { canUseMediaComments } from "@/lib/media-comments";
import { createNotification } from "@/lib/Notification";
import * as EffectRuntime from "@/lib/server";

export async function newMediaComment(data: {
	videoId: Video.VideoId;
	commentId: Comment.CommentId;
	uploadToken: string;
	kind: Comment.MediaKind;
	durationSeconds: number;
	parentCommentId: Comment.CommentId;
	timestamp: number | null;
	content?: string;
	width?: number;
	height?: number;
	waveform?: number[];
	hasThumbnail?: boolean;
	authorImage: ImageUpload.ImageUrl | null;
}) {
	const user = await getCurrentUser();
	if (!user) throw new Error("User not authenticated");

	// The token minted by /api/upload/comment-media/initiate is the capability
	// tying this comment id + key to the uploader; the client never supplies a
	// key directly.
	const claims = verifyCommentMediaUploadToken(data.uploadToken);
	if (
		!claims ||
		claims.userId !== user.id ||
		claims.videoId !== data.videoId ||
		claims.commentId !== data.commentId ||
		claims.kind !== data.kind
	)
		throw new Error("Invalid upload token");

	if (!Number.isFinite(data.durationSeconds) || data.durationSeconds < 0)
		throw new Error("Invalid duration");

	// Same rationale as new-comment.ts: authentication alone isn't
	// authorization, and canView returns true for nonexistent ids, so fetch the
	// row under the policy.
	const accessExit = await Effect.gen(function* () {
		const repo = yield* VideosRepo;
		const videosPolicy = yield* VideosPolicy;
		return yield* repo
			.getById(data.videoId)
			.pipe(Policy.withPublicPolicy(videosPolicy.canView(data.videoId)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(accessExit) || Option.isNone(accessExit.value))
		throw new Error("Video not found");
	const [video] = accessExit.value.value;

	const expectedPrefix = `${video.ownerId}/${video.id}/comments/${data.commentId}/`;
	if (!claims.key.startsWith(expectedPrefix))
		throw new Error("Invalid media key");

	// Re-checked here (not just at initiate) in case the owner's plan lapsed
	// between presign and create.
	if (!(await canUseMediaComments(user, video)))
		throw new Error("Media comments are not available on this video");

	const verifyExit = await Effect.gen(function* () {
		const [bucket] = yield* Storage.getAccessForVideo(video);
		const head = yield* bucket.headObject(claims.key);

		let thumbnailKey =
			data.hasThumbnail && claims.thumbnailKey ? claims.thumbnailKey : null;
		if (thumbnailKey) {
			// A missing thumbnail degrades the card, it doesn't block the comment.
			const thumbnailExists = yield* bucket.headObject(thumbnailKey).pipe(
				Effect.map(() => true),
				Effect.catchAll(() => Effect.succeed(false)),
			);
			if (!thumbnailExists) thumbnailKey = null;
		}

		return { size: head.ContentLength, thumbnailKey };
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(verifyExit)) throw new Error("Upload not found");
	const { size, thumbnailKey } = verifyExit.value;

	const content = (data.content ?? "").trim();
	const now = new Date();
	const newComment = {
		id: data.commentId,
		authorId: user.id,
		type: data.kind,
		content,
		videoId: data.videoId,
		timestamp: data.timestamp ?? null,
		parentCommentId: data.parentCommentId,
		mediaKey: claims.key,
		mediaDuration: data.durationSeconds,
		mediaMeta: {
			mime: claims.contentType,
			size,
			width: data.width,
			height: data.height,
			thumbnailKey: thumbnailKey ?? undefined,
			waveform: sanitizeWaveform(data.waveform),
		},
		createdAt: now,
		updatedAt: now,
	};

	await db().insert(comments).values(newComment);

	try {
		await createNotification({
			// Truthiness on purpose: the web client uses "" for top-level comments
			// while other APIs use NULL.
			type: data.parentCommentId ? "reply" : "comment",
			videoId: data.videoId,
			authorId: user.id,
			comment: {
				id: data.commentId,
				// The label feeds notification emails; an empty string would ship a
				// blank email body.
				content:
					content ||
					(data.kind === "video" ? "🎥 Video comment" : "🎙️ Voice note"),
			},
			parentCommentId: data.parentCommentId,
		});
	} catch (error) {
		console.error("Failed to create notification:", error);
	}

	revalidatePath(`/s/${data.videoId}`);

	return {
		...newComment,
		authorName: user.name,
		authorImage: data.authorImage,
		sending: false,
	};
}
