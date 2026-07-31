import { db } from "@cap/database";
import {
	comments,
	messengerSupportEmails,
	users,
	videos,
} from "@cap/database/schema";
import { and, eq, gte, isNotNull, lte, notInArray } from "drizzle-orm";
import { ACCOUNT_DELETION_PENDING_SUBJECT } from "@/lib/account-deletion-request";
import {
	collaborationActionCreatedEvent,
	shareLinkCreatedEvent,
	userSignedUpEvent,
} from "@/lib/analytics/business-events";
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
	const pendingDeletionUserIds = db()
		.select({ userId: messengerSupportEmails.userId })
		.from(messengerSupportEmails)
		.where(
			and(
				eq(messengerSupportEmails.subject, ACCOUNT_DELETION_PENDING_SUBJECT),
				isNotNull(messengerSupportEmails.userId),
			),
		);
	const [recentUsers, recentVideos, recentComments] = await Promise.all([
		db()
			.select({
				id: users.id,
				organizationId: users.activeOrganizationId,
				createdAt: users.created_at,
			})
			.from(users)
			.where(
				and(
					gte(users.created_at, start),
					lte(users.created_at, end),
					notInArray(users.id, pendingDeletionUserIds),
				),
			)
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
			.where(
				and(
					gte(videos.createdAt, start),
					lte(videos.createdAt, end),
					notInArray(videos.ownerId, pendingDeletionUserIds),
				),
			)
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
			.where(
				and(
					gte(comments.createdAt, start),
					lte(comments.createdAt, end),
					notInArray(comments.authorId, pendingDeletionUserIds),
				),
			)
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
		...recentUsers.map((user) =>
			userSignedUpEvent({
				userId: user.id,
				organizationId: user.organizationId,
				createdAt: user.createdAt,
			}),
		),
		...recentVideos.map((video) =>
			shareLinkCreatedEvent({
				videoId: video.id,
				userId: video.userId,
				organizationId: video.organizationId,
				createdAt: video.createdAt,
				isScreenshot: video.isScreenshot,
				sourceType: video.source.type,
			}),
		),
		...recentComments.map((comment) =>
			collaborationActionCreatedEvent({
				commentId: comment.id,
				userId: comment.authorId,
				organizationId: comment.organizationId,
				createdAt: comment.createdAt,
				action: comment.parentCommentId
					? "reply"
					: comment.type === "emoji"
						? "reaction"
						: "comment",
			}),
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
