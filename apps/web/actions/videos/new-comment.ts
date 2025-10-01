"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { comments, videos } from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { revalidatePath } from "next/cache";
import { createNotification } from "@/lib/Notification";
import { eq } from "drizzle-orm";

export async function newComment({
	content,
	videoId,
	type,
	parentCommentId,
	timestamp,
}: {
	content: string;
	videoId: Video.VideoId;
	type: "text" | "emoji";
	parentCommentId: string;
	timestamp: number;
}) {
	const user = await getCurrentUser();
	if (!user) throw new Error("User not authenticated");

	const conditionalType = parentCommentId
		? "reply"
		: type === "emoji"
			? "reaction"
			: "comment";

	const [video] = await db()
		.select({ orgId: videos.orgId })
		.from(videos)
		.where(eq(videos.id, videoId));
	if (!content || !videoId) throw new Error("Content and videoId are required");
	if (!video) throw new Error("Video not found");

	const newComment = {
		id: nanoId(),
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

	try {
		await createNotification({
			type: conditionalType,
			videoId,
			authorId: user.id,
			comment: { id: newComment.id, content },
			parentCommentId,
		});
	} catch (error) {
		console.error("Failed to create notification:", error);
	}

	// Add author name to the returned data
	const commentWithAuthor = {
		...newComment,
		authorName: user.name,
		sending: false,
	};

	revalidatePath(`/s/${videoId}`);

	return commentWithAuthor;
}
