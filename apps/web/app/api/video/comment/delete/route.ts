import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { comments } from "@cap/database/schema";
import { and, eq, or } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getHeaders } from "@/utils/helpers";

export async function DELETE(request: NextRequest) {
	const user = await getCurrentUser();
	const { searchParams } = request.nextUrl;
	const commentId = searchParams.get("commentId");
	const origin = request.headers.get("origin") as string;

	if (!commentId || !user?.id) {
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
			.where(and(eq(comments.id, commentId), eq(comments.authorId, user.id)));

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
				or(eq(comments.id, commentId), eq(comments.parentCommentId, commentId)),
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
