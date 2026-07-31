import { db } from "@cap/database";
import {
	comments,
	messengerSupportEmails,
	users,
	videos,
} from "@cap/database/schema";
import { stripe } from "@cap/utils";
import { and, eq, gte, inArray, isNotNull, lte, notInArray } from "drizzle-orm";
import type Stripe from "stripe";
import { ACCOUNT_DELETION_PENDING_SUBJECT } from "@/lib/account-deletion-request";
import {
	collaborationActionCreatedEvent,
	shareLinkCreatedEvent,
	userSignedUpEvent,
} from "@/lib/analytics/business-events";
import {
	isSettledSubscriptionPurchase,
	isStartedSubscriptionTrial,
	subscriptionCheckoutProductEvent,
} from "@/lib/analytics/stripe-business-events";
import { enqueueReconciledProductAnalyticsEventStep } from "./deliver-product-analytics-event";

const RECONCILIATION_ROW_LIMIT = 5_000;
const STRIPE_CHECKOUT_EVENT_TYPES = [
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
] as const;

function reconciliationWindow(scheduledAt: string, lookbackHours: number) {
	const end = new Date(scheduledAt);
	if (
		!Number.isFinite(end.getTime()) ||
		!Number.isInteger(lookbackHours) ||
		lookbackHours < 1 ||
		lookbackHours > 24 * 30
	) {
		throw new Error("Invalid product analytics reconciliation window");
	}
	return {
		end,
		start: new Date(end.getTime() - lookbackHours * 60 * 60 * 1_000),
	};
}

export async function loadProductAnalyticsReconciliationEventsStep({
	scheduledAt,
	lookbackHours,
}: {
	scheduledAt: string;
	lookbackHours: number;
}) {
	"use step";

	const { end, start } = reconciliationWindow(scheduledAt, lookbackHours);
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

export async function loadStripeAnalyticsReconciliationEventsStep({
	scheduledAt,
	lookbackHours,
}: {
	scheduledAt: string;
	lookbackHours: number;
}) {
	"use step";

	const { end, start } = reconciliationWindow(scheduledAt, lookbackHours);
	const checkoutEvents: Stripe.Event[] = [];
	for (const type of STRIPE_CHECKOUT_EVENT_TYPES) {
		let startingAfter: string | undefined;
		for (;;) {
			const page = await stripe().events.list({
				type,
				created: {
					gte: Math.floor(start.getTime() / 1_000),
					lte: Math.floor(end.getTime() / 1_000),
				},
				limit: 100,
				...(startingAfter ? { starting_after: startingAfter } : {}),
			});
			checkoutEvents.push(...page.data);
			if (checkoutEvents.length > RECONCILIATION_ROW_LIMIT) {
				throw new Error("Stripe analytics reconciliation row limit exceeded");
			}
			if (!page.has_more || page.data.length === 0) break;
			startingAfter = page.data.at(-1)?.id;
			if (!startingAfter) {
				throw new Error("Stripe analytics reconciliation pagination failed");
			}
		}
	}

	const sessions = checkoutEvents
		.map((event) => ({
			event,
			session: event.data.object as Stripe.Checkout.Session,
		}))
		.filter(
			({ session }) =>
				session.metadata?.type !== "developer_credits" &&
				typeof session.customer === "string" &&
				typeof session.subscription === "string",
		);
	const customerIds = [
		...new Set(sessions.map(({ session }) => session.customer as string)),
	];
	const analyticsUsers =
		customerIds.length === 0
			? []
			: await db()
					.select({
						id: users.id,
						activeOrganizationId: users.activeOrganizationId,
						stripeCustomerId: users.stripeCustomerId,
					})
					.from(users)
					.where(inArray(users.stripeCustomerId, customerIds));
	const usersByCustomerId = new Map(
		analyticsUsers.flatMap((user) =>
			user.stripeCustomerId ? [[user.stripeCustomerId, user] as const] : [],
		),
	);
	const reconciled = [];
	for (const { event, session } of sessions) {
		const user = usersByCustomerId.get(session.customer as string);
		if (!user) {
			throw new Error("Stripe checkout has no matching analytics user");
		}
		const subscription = await stripe().subscriptions.retrieve(
			session.subscription as string,
		);
		if (
			!isSettledSubscriptionPurchase(session, subscription) &&
			!isStartedSubscriptionTrial(session, subscription)
		) {
			continue;
		}
		const inviteQuota = subscription.items.data.reduce(
			(total, item) => total + (item.quantity || 1),
			0,
		);
		const productEvent = subscriptionCheckoutProductEvent({
			eventId: event.id,
			occurredAt: new Date(event.created * 1_000).toISOString(),
			session,
			subscription,
			inviteQuota,
			user,
		});
		if (productEvent) reconciled.push(productEvent);
	}
	return reconciled;
}
loadStripeAnalyticsReconciliationEventsStep.maxRetries = 4;

export async function reconcileProductAnalyticsWorkflow(input: {
	scheduledAt: string;
	lookbackHours: number;
}) {
	"use workflow";

	const events = await loadProductAnalyticsReconciliationEventsStep(input);
	const stripeEvents = await loadStripeAnalyticsReconciliationEventsStep(input);
	for (const event of [...events, ...stripeEvents]) {
		await enqueueReconciledProductAnalyticsEventStep(event);
	}
	return {
		databaseReconciled: events.length,
		stripeReconciled: stripeEvents.length,
	};
}
