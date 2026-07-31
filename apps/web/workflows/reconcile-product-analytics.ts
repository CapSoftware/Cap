import { db } from "@cap/database";
import { comments, users, videos } from "@cap/database/schema";
import { and, eq, gte, lte } from "drizzle-orm";
import type { ServerProductEvent } from "@/lib/analytics/server-event";
import { enqueueReconciledProductAnalyticsEventStep } from "./deliver-product-analytics-event";

const RECONCILIATION_ROW_LIMIT = 5_000;

export async function loadProductAnalyticsReconciliationEventsStep({
	scheduledAt,
	lookbackHours,
}: {
	scheduledAt: string;
	lookbackHours: number;
}) {
	"use step";

	const end = new Date(scheduledAt);
	if (
		!Number.isFinite(end.getTime()) ||
		!Number.isInteger(lookbackHours) ||
		lookbackHours < 1 ||
		lookbackHours > 24 * 30
	) {
		throw new Error("Invalid product analytics reconciliation window");
	}
	const start = new Date(end.getTime() - lookbackHours * 60 * 60 * 1_000);
	const [recentUsers, recentVideos, recentComments] = await Promise.all([
		db()
			.select({
				id: users.id,
				organizationId: users.activeOrganizationId,
				createdAt: users.created_at,
			})
			.from(users)
			.where(and(gte(users.created_at, start), lte(users.created_at, end)))
			.limit(RECONCILIATION_ROW_LIMIT + 1),
		db()
			.select({
				id: videos.id,
				userId: videos.ownerId,
				organizationId: videos.orgId,
				createdAt: videos.createdAt,
				isScreenshot: videos.isScreenshot,
				source: videos.source,
			})
			.from(videos)
			.where(and(gte(videos.createdAt, start), lte(videos.createdAt, end)))
			.limit(RECONCILIATION_ROW_LIMIT + 1),
		db()
			.select({
				id: comments.id,
				authorId: comments.authorId,
				organizationId: videos.orgId,
				createdAt: comments.createdAt,
				type: comments.type,
				parentCommentId: comments.parentCommentId,
			})
			.from(comments)
			.leftJoin(videos, eq(comments.videoId, videos.id))
			.where(and(gte(comments.createdAt, start), lte(comments.createdAt, end)))
			.limit(RECONCILIATION_ROW_LIMIT + 1),
	]);
	if (
		recentUsers.length > RECONCILIATION_ROW_LIMIT ||
		recentVideos.length > RECONCILIATION_ROW_LIMIT ||
		recentComments.length > RECONCILIATION_ROW_LIMIT
	) {
		throw new Error("Product analytics reconciliation row limit exceeded");
	}

	return [
		...recentUsers.map(
			(user) =>
				({
					eventId: `signup:${user.id}`,
					eventName: "user_signed_up",
					occurredAt: user.createdAt.toISOString(),
					platform: "server",
					userId: user.id,
					organizationId: user.organizationId ?? undefined,
				}) satisfies ServerProductEvent,
		),
		...recentVideos.map(
			(video) =>
				({
					eventId: `share_link_created:${video.id}`,
					eventName: "share_link_created",
					occurredAt: video.createdAt.toISOString(),
					platform: "server",
					userId: video.userId,
					organizationId: video.organizationId,
					properties: {
						asset_type: video.isScreenshot ? "screenshot" : "recording",
						recording_mode: video.source.type,
					},
				}) satisfies ServerProductEvent,
		),
		...recentComments.map(
			(comment) =>
				({
					eventId: `collaboration:${comment.id}`,
					eventName: "collaboration_action_created",
					occurredAt: comment.createdAt.toISOString(),
					platform: "server",
					userId: comment.authorId,
					organizationId: comment.organizationId ?? undefined,
					properties: {
						action: comment.parentCommentId
							? "reply"
							: comment.type === "emoji"
								? "reaction"
								: "comment",
					},
				}) satisfies ServerProductEvent,
		),
	];
}
loadProductAnalyticsReconciliationEventsStep.maxRetries = 4;

export async function reconcileProductAnalyticsWorkflow(input: {
	scheduledAt: string;
	lookbackHours: number;
}) {
	"use workflow";

	const events = await loadProductAnalyticsReconciliationEventsStep(input);
	for (const event of events) {
		await enqueueReconciledProductAnalyticsEventStep(event);
	}
	return { reconciled: events.length };
}
