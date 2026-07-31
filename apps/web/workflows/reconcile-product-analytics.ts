import { PRODUCT_ANALYTICS_ACCOUNT_DELETION_PENDING_SUBJECT } from "@cap/analytics";
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
import {
	checkoutStartedEvent,
	collaborationActionCreatedEvent,
	guestCheckoutStartedEvent,
	shareLinkCreatedEvent,
	userSignedUpEvent,
} from "@/lib/analytics/business-events";
import {
	isSettledSubscriptionPurchase,
	subscriptionCheckoutProductEvent,
	subscriptionTrialStartedProductEvent,
} from "@/lib/analytics/stripe-business-events";
import { enqueueReconciledProductAnalyticsEventStep } from "./deliver-product-analytics-event";

const RECONCILIATION_ROW_LIMIT = 5_000;
const STRIPE_ANALYTICS_EVENT_TYPES = [
	"checkout.session.created",
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
	"customer.subscription.created",
] as const;

const checkoutQuantity = (session: Stripe.Checkout.Session) => {
	const quantity = Number(session.metadata?.analyticsQuantity);
	return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : undefined;
};

const videoAnalyticsPlatform = (video: {
	metadata: unknown;
	source: { type: string };
}) => {
	const metadata =
		typeof video.metadata === "object" && video.metadata !== null
			? (video.metadata as Record<string, unknown>)
			: {};
	if (
		metadata.source === "mobileUpload" ||
		metadata.source === "mobileCamera"
	) {
		return "mobile" as const;
	}
	if (
		video.source.type === "desktopMP4" ||
		video.source.type === "desktopSegments" ||
		video.source.type === "local"
	) {
		return "desktop" as const;
	}
	return "server" as const;
};

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
				eq(
					messengerSupportEmails.subject,
					PRODUCT_ANALYTICS_ACCOUNT_DELETION_PENDING_SUBJECT,
				),
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
				metadata: videos.metadata,
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
				createdAt: user.createdAt,
			}),
		),
		...recentVideos.map((video) =>
			shareLinkCreatedEvent({
				videoId: video.id,
				platform: videoAnalyticsPlatform(video),
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
	const stripeEvents: Stripe.Event[] = [];
	for (const type of STRIPE_ANALYTICS_EVENT_TYPES) {
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
			stripeEvents.push(...page.data);
			if (stripeEvents.length > RECONCILIATION_ROW_LIMIT) {
				throw new Error("Stripe analytics reconciliation row limit exceeded");
			}
			if (!page.has_more || page.data.length === 0) break;
			startingAfter = page.data.at(-1)?.id;
			if (!startingAfter) {
				throw new Error("Stripe analytics reconciliation pagination failed");
			}
		}
	}

	const sessions = stripeEvents
		.filter(({ type }) => type.startsWith("checkout.session."))
		.map((event) => ({
			event,
			session: event.data.object as Stripe.Checkout.Session,
		}))
		.filter(({ session }) => session.metadata?.type !== "developer_credits");
	const createdSubscriptions = stripeEvents
		.filter(({ type }) => type === "customer.subscription.created")
		.map((event) => ({
			event,
			subscription: event.data.object as Stripe.Subscription,
		}));
	const customerIds = [
		...new Set(
			[
				...sessions.map(({ session }) => session.customer),
				...createdSubscriptions.map(
					({ subscription }) => subscription.customer,
				),
			].flatMap((customer) => (typeof customer === "string" ? [customer] : [])),
		),
	];
	const analyticsUsers =
		customerIds.length === 0
			? []
			: await db()
					.select({
						id: users.id,
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
	let legacyStripeEventsSkipped = 0;
	for (const { event, subscription } of createdSubscriptions) {
		const analyticsSchemaVersion = subscription.metadata.analyticsSchemaVersion;
		if (!analyticsSchemaVersion) {
			legacyStripeEventsSkipped += 1;
			continue;
		}
		if (analyticsSchemaVersion !== "1") {
			throw new Error(
				"Stripe subscription has an unsupported analytics schema",
			);
		}
		if (subscription.status !== "trialing") continue;
		if (typeof subscription.customer !== "string") {
			throw new Error("Stripe subscription is missing a customer");
		}
		const user = usersByCustomerId.get(subscription.customer);
		if (!user) {
			throw new Error("Stripe subscription has no matching analytics user");
		}
		const productEvent = subscriptionTrialStartedProductEvent({
			eventId: event.id,
			occurredAt: new Date(event.created * 1_000).toISOString(),
			subscription,
			user,
		});
		if (productEvent) reconciled.push(productEvent);
	}
	for (const { event, session } of sessions) {
		if (String(event.type) === "checkout.session.created") {
			const analyticsSchemaVersion = session.metadata?.analyticsSchemaVersion;
			if (!analyticsSchemaVersion) {
				legacyStripeEventsSkipped += 1;
				continue;
			}
			if (analyticsSchemaVersion !== "1") {
				throw new Error("Stripe checkout has an unsupported analytics schema");
			}
			const priceId = session.metadata?.analyticsPriceId;
			const quantity = checkoutQuantity(session);
			const anonymousId = session.metadata?.analyticsAnonymousId;
			if (!priceId || !quantity) {
				throw new Error("Stripe checkout is missing analytics metadata");
			}
			const createdAt = new Date(session.created * 1_000);
			if (session.metadata?.guestCheckout === "true") {
				if (!anonymousId) {
					throw new Error("Guest checkout is missing analytics identity");
				}
				reconciled.push(
					guestCheckoutStartedEvent({
						checkoutId: session.id,
						createdAt,
						platform:
							session.metadata?.platform === "mobile" ? "mobile" : "web",
						anonymousId,
						priceId,
						quantity,
					}),
				);
				continue;
			}
			if (typeof session.customer !== "string") {
				throw new Error("Authenticated checkout is missing a customer");
			}
			const user = usersByCustomerId.get(session.customer);
			if (!user) {
				throw new Error("Stripe checkout has no matching analytics user");
			}
			reconciled.push(
				checkoutStartedEvent({
					checkoutId: session.id,
					createdAt,
					platform:
						session.metadata?.platform === "desktop"
							? "desktop"
							: session.metadata?.platform === "mobile"
								? "mobile"
								: "web",
					userId: user.id,
					organizationId: session.metadata?.analyticsOrganizationId,
					anonymousId,
					priceId,
					quantity,
					isOnboarding: session.metadata?.isOnBoarding === "true",
				}),
			);
			continue;
		}
		const analyticsSchemaVersion = session.metadata?.analyticsSchemaVersion;
		if (!analyticsSchemaVersion) {
			legacyStripeEventsSkipped += 1;
			continue;
		}
		if (analyticsSchemaVersion !== "1") {
			throw new Error("Stripe checkout has an unsupported analytics schema");
		}
		if (
			typeof session.customer !== "string" ||
			typeof session.subscription !== "string"
		) {
			continue;
		}
		const user = usersByCustomerId.get(session.customer);
		if (!user)
			throw new Error("Stripe checkout has no matching analytics user");
		if (!isSettledSubscriptionPurchase(session)) continue;
		const productEvent = subscriptionCheckoutProductEvent({
			eventId: event.id,
			occurredAt: new Date(event.created * 1_000).toISOString(),
			session,
			user,
		});
		if (productEvent) reconciled.push(productEvent);
	}
	return { events: reconciled, legacyStripeEventsSkipped };
}
loadStripeAnalyticsReconciliationEventsStep.maxRetries = 4;

export async function reconcileProductAnalyticsWorkflow(input: {
	scheduledAt: string;
	lookbackHours: number;
}) {
	"use workflow";

	const events = await loadProductAnalyticsReconciliationEventsStep(input);
	const stripeReconciliation =
		await loadStripeAnalyticsReconciliationEventsStep(input);
	for (const event of [...events, ...stripeReconciliation.events]) {
		await enqueueReconciledProductAnalyticsEventStep(event);
	}
	return {
		databaseReconciled: events.length,
		stripeReconciled: stripeReconciliation.events.length,
		legacyStripeEventsSkipped: stripeReconciliation.legacyStripeEventsSkipped,
	};
}
