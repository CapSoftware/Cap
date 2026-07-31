"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { comments, videos } from "@cap/database/schema";
import type { ImageUpload } from "@cap/web-domain";
import { Comment, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { collaborationActionCreatedEvent } from "@/lib/analytics/business-events";
import { queueServerProductEvent } from "@/lib/analytics/server";
import { createNotification } from "@/lib/Notification";

export async function newComment(data: {
	content: string;
	videoId: Video.VideoId;
	type: "text" | "emoji";
	authorImage: ImageUpload.ImageUrl | null;
	parentCommentId: Comment.CommentId;
	timestamp: number | null;
}) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("User not authenticated");
	}

	const content = data.content;
	const videoId = data.videoId;
	const type = data.type;
	const parentCommentId = data.parentCommentId;
	const timestamp = data.timestamp;
	const conditionalType = parentCommentId
		? "reply"
		: type === "emoji"
			? "reaction"
			: "comment";

	if (!content || !videoId) {
		throw new Error("Content and videoId are required");
	}
	const [commentVideo] = await db()
		.select({ organizationId: videos.orgId })
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);
	if (!commentVideo) {
		throw new Error("Video not found");
	}
	const id = Comment.CommentId.make(nanoId());

	const newComment = {
		id: id,
		authorId: user.id,
		type: type,
		content: content,
		videoId: videoId,
		timestamp: timestamp ?? null,
		parentCommentId: parentCommentId,
		createdAt: new Date(),
		updatedAt: new Date(),
	};

	await db().insert(comments).values(newComment);
	await queueServerProductEvent(
		collaborationActionCreatedEvent({
			commentId: id,
			userId: user.id,
			organizationId: commentVideo.organizationId,
			createdAt: newComment.createdAt,
			action: conditionalType,
		}),
	).catch(() => {
		console.error("Failed to enqueue product analytics collaboration event");
	});

	try {
		await createNotification({
			type: conditionalType,
			videoId,
			authorId: user.id,
			comment: { id, content },
			parentCommentId,
		});
	} catch (error) {
		console.error("Failed to create notification:", error);
	}

	// Add author name to the returned data
	const commentWithAuthor = {
		...newComment,
		authorName: user.name,
		authorImage: data.authorImage,
		sending: false,
	};

	revalidatePath(`/s/${videoId}`);

	return commentWithAuthor;
}
