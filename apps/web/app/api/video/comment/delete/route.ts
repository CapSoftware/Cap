import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import { comments } from "@inflight/database/schema";
import { Comment } from "@inflight/web-domain";
import { and, eq, or } from "drizzle-orm";
import { Option } from "effect";
import type { NextRequest } from "next/server";
import { getHeaders } from "@/utils/helpers";

export async function DELETE(request: NextRequest) {
	const user = await getCurrentUser();
	const { searchParams } = request.nextUrl;
	const commentId = Option.fromNullable(searchParams.get("commentId")).pipe(
		Option.map(Comment.CommentId.make),
	);
	const origin = request.headers.get("origin");

	if (!Option.isSome(commentId) || !user?.id) {
		return new Response(JSON.stringify({ error: "Missing required data" }), {
			status: 400,
			headers: getHeaders(origin),
		});
	}

	try {
		// First, verify that the comment belongs to the user
		const query = await db()
			.select()
			.from(comments)
			.where(
				and(eq(comments.id, commentId.value), eq(comments.authorId, user.id)),
			);

		if (query.length === 0) {
			return new Response(
				JSON.stringify({ error: "Comment not found or unauthorized" }),
				{
					status: 404,
					headers: getHeaders(origin),
				},
			);
		}

		// Delete the comment and all its replies
		await db()
			.delete(comments)
			.where(
				or(
					eq(comments.id, commentId.value),
					eq(comments.parentCommentId, commentId.value),
				),
			);

		return new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: getHeaders(origin),
		});
	} catch (error) {
		console.error("Error deleting comment:", error);
		return new Response(JSON.stringify({ error: "Failed to delete comment" }), {
			status: 500,
			headers: getHeaders(origin),
		});
	}
}
