import { db } from "@inflight/database";
import { sendEmail } from "@inflight/database/emails/config";
import { NewComment } from "@inflight/database/emails/new-comment";
import { comments, users, videos } from "@inflight/database/schema";
import { buildEnv, serverEnv } from "@inflight/env";
import { and, eq, gt, ne } from "drizzle-orm";
import type { NextRequest } from "next/server";

const lastEmailSentCache = new Map<string, Date>();

export async function POST(request: NextRequest) {
	console.log("Processing new comment email notification");
	const { commentId } = await request.json();

	if (!commentId) {
		console.error("Missing required field: commentId");
		return Response.json(
			{ error: "Missing required fields: commentId" },
			{ status: 400 },
		);
	}

	try {
		console.log(`Fetching comment details for commentId: ${commentId}`);
		// Get the comment details
		const commentDetails = await db()
			.select({
				id: comments.id,
				content: comments.content,
				type: comments.type,
				videoId: comments.videoId,
				authorId: comments.authorId,
				createdAt: comments.createdAt,
			})
			.from(comments)
			.where(eq(comments.id, commentId))
			.limit(1);

		if (!commentDetails || commentDetails.length === 0) {
			console.error(`Comment not found for commentId: ${commentId}`);
			return Response.json({ error: "Comment not found" }, { status: 404 });
		}

		const comment = commentDetails[0];
		if (comment) {
			console.log(
				`Found comment: ${comment.id}, type: ${comment.type}, videoId: ${comment.videoId}`,
			);
		}

		if (
			!comment ||
			comment.type !== "text" ||
			!comment.videoId ||
			!comment.content
		) {
			console.log(
				"Skipping email notification - invalid comment data or non-text comment",
			);
			return Response.json(
				{ success: false, reason: "Invalid comment data" },
				{ status: 200 },
			);
		}

		console.log(`Fetching video details for videoId: ${comment.videoId}`);
		// Get the video details
		const videoDetails = await db()
			.select({
				id: videos.id,
				name: videos.name,
				ownerId: videos.ownerId,
			})
			.from(videos)
			.where(eq(videos.id, comment.videoId))
			.limit(1);

		if (!videoDetails || videoDetails.length === 0) {
			console.error(`Video not found for videoId: ${comment.videoId}`);
			return Response.json({ error: "Video not found" }, { status: 404 });
		}

		const video = videoDetails[0];
		if (video) {
			console.log(
				`Found video: ${video.id}, name: ${video.name}, ownerId: ${video.ownerId}`,
			);
		}

		if (!video || !video.ownerId || !video.id || !video.name) {
			console.error("Invalid video data");
			return Response.json({ error: "Invalid video data" }, { status: 500 });
		}

		console.log(`Fetching owner details for userId: ${video.ownerId}`);
		// Get the video owner's email
		const ownerDetails = await db()
			.select({
				id: users.id,
				email: users.email,
			})
			.from(users)
			.where(eq(users.id, video.ownerId))
			.limit(1);

		if (
			!ownerDetails ||
			!ownerDetails.length ||
			!ownerDetails[0] ||
			!ownerDetails[0].email
		) {
			console.error(`Video owner not found for userId: ${video.ownerId}`);
			return Response.json({ error: "Video owner not found" }, { status: 404 });
		}

		const owner = ownerDetails[0];
		console.log(`Found owner: ${owner.id}, email: ${owner.email}`);

		if (!owner || !owner.email || !owner.id) {
			console.error("Invalid owner data");
			return Response.json({ error: "Invalid owner data" }, { status: 500 });
		}

		let commenterName = "Anonymous";
		if (comment.authorId) {
			console.log(`Fetching commenter details for userId: ${comment.authorId}`);
			const commenterDetails = await db()
				.select({
					id: users.id,
					name: users.name,
				})
				.from(users)
				.where(eq(users.id, comment.authorId))
				.limit(1);

			if (
				commenterDetails &&
				commenterDetails.length > 0 &&
				commenterDetails[0] &&
				commenterDetails[0].name
			) {
				commenterName = commenterDetails[0].name;
				console.log(`Found commenter name: ${commenterName}`);
			} else {
				console.log("Commenter details not found, using 'Anonymous'");
			}
		} else {
			console.log("No authorId provided, using 'Anonymous'");
		}

		const now = new Date();
		const lastEmailSent = lastEmailSentCache.get(owner.id);

		if (lastEmailSent) {
			const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);

			if (lastEmailSent > fifteenMinutesAgo) {
				console.log(
					`Rate limiting email to user ${
						owner.id
					} - last email sent at ${lastEmailSent.toISOString()}`,
				);
				return Response.json(
					{ success: false, reason: "Email rate limited" },
					{ status: 200 },
				);
			}
		}

		const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
		console.log(
			`Checking for recent comments since ${fifteenMinutesAgo.toISOString()}`,
		);
		const recentComments = await db()
			.select({
				id: comments.id,
			})
			.from(comments)
			.where(
				and(
					eq(comments.videoId, comment.videoId),
					eq(comments.type, "text"),
					gt(comments.createdAt, fifteenMinutesAgo),
					ne(comments.id, commentId),
				),
			)
			.limit(1);

		if (recentComments && recentComments.length > 0 && recentComments[0]) {
			console.log(
				`Found recent comment ${recentComments[0].id}, skipping email notification`,
			);
			return Response.json(
				{ success: false, reason: "Recent comment found" },
				{ status: 200 },
			);
		}

		// Generate the video URL
		const videoUrl = buildEnv.NEXT_PUBLIC_IS_CAP
			? `https://cap.link/${video.id}`
			: `${serverEnv().WEB_URL}/s/${video.id}`;
		console.log(`Generated video URL: ${videoUrl}`);

		console.log(
			`Sending email to ${owner.email} about comment on video "${video.name}"`,
		);

		try {
			const emailResult = await sendEmail({
				email: owner.email,
				subject: `New comment on your Cap: ${video.name}`,
				react: NewComment({
					email: owner.email,
					url: videoUrl,
					videoName: video.name,
					commenterName,
					commentContent: comment.content,
				}),
				marketing: true,
			});

			console.log("Email send result:", emailResult);
			console.log("Email sent successfully");

			lastEmailSentCache.set(owner.id, now);
			console.log(`Updated email cache for user ${owner.id}`);

			return Response.json({ success: true }, { status: 200 });
		} catch (emailError) {
			console.error("Error sending email via Resend:", emailError);
			return Response.json(
				{ error: "Failed to send email", details: String(emailError) },
				{ status: 500 },
			);
		}
	} catch (error) {
		console.error("Error sending new comment email:", error);
		return Response.json({ error: "Failed to send email" }, { status: 500 });
	}
}
