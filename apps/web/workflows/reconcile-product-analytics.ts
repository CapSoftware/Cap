import { createHash } from "node:crypto";
import { PRODUCT_ANALYTICS_ACCOUNT_DELETION_PENDING_SUBJECT } from "@cap/analytics";
import { db } from "@cap/database";
import {
	comments,
	messengerSupportEmails,
	productAnalyticsReconciliationFailures,
	users,
	videos,
} from "@cap/database/schema";
import { stripe } from "@cap/utils";
import {
	and,
	asc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	lte,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import type Stripe from "stripe";
import {
	checkoutStartedEvent,
	collaborationActionCreatedEvent,
	firstViewReceivedEvent,
	guestCheckoutStartedEvent,
	shareLinkCreatedEvent,
	userSignedUpEvent,
} from "@/lib/analytics/business-events";
import { queueDurableServerProductEvent } from "@/lib/analytics/product-event-outbox";
import {
	isFirstPositiveSubscriptionPayment,
	isSettledSubscriptionPurchase,
	subscriptionCancelledProductEvent,
	subscriptionChangedProductEvents,
	subscriptionCheckoutProductEvent,
	subscriptionInvoicePaidProductEvent,
	subscriptionPaymentFailedProductEvent,
	subscriptionRefundedProductEvent,
	subscriptionTrialConvertedProductEvent,
	subscriptionTrialStartedProductEvent,
} from "@/lib/analytics/stripe-business-events";
import { videoAnalyticsPlatform } from "@/lib/analytics/video-platform";

const RECONCILIATION_PAGE_SIZE = 250;
const RECONCILIATION_ENQUEUE_CONCURRENCY = 10;
const MAX_RECONCILIATION_PAGES_PER_SOURCE = 10_000;
const STRIPE_ANALYTICS_EVENT_TYPES = [
	"checkout.session.created",
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
	"charge.refunded",
	"invoice.paid",
	"invoice.payment_failed",
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
] as const;

const checkoutQuantity = (session: Stripe.Checkout.Session) => {
	const quantity = Number(session.metadata?.analyticsQuantity);
	return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : undefined;
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

type DatabaseReconciliationSource =
	| "comment"
	| "first_view"
	| "signup"
	| "video";

type ReconciliationSourceType =
	| `database_${DatabaseReconciliationSource}`
	| "stripe_event";

type ReconciliationCandidate = {
	event: () => Parameters<typeof queueDurableServerProductEvent>[0];
	sourceId: string;
	sourceType: ReconciliationSourceType;
};

const reconciliationSourceHash = (
	sourceType: ReconciliationSourceType,
	sourceId: string,
) =>
	createHash("sha256")
		.update(`reconciliation\0${sourceType}\0${sourceId}`)
		.digest("hex");

async function recordReconciliationFailure({
	errorCode,
	sourceHash,
	sourceType,
}: {
	errorCode: "event_invalid" | "queue_failed";
	sourceHash: string;
	sourceType: ReconciliationSourceType;
}) {
	await db()
		.insert(productAnalyticsReconciliationFailures)
		.values({ errorCode, sourceHash, sourceType })
		.onDuplicateKeyUpdate({
			set: {
				attemptCount: sql`${productAnalyticsReconciliationFailures.attemptCount} + 1`,
				errorCode,
				lastSeenAt: new Date(),
			},
		});
}

async function reconcileCandidate(candidate: ReconciliationCandidate) {
	const sourceHash = reconciliationSourceHash(
		candidate.sourceType,
		candidate.sourceId,
	);
	let event: Parameters<typeof queueDurableServerProductEvent>[0];
	try {
		event = candidate.event();
	} catch {
		await recordReconciliationFailure({
			errorCode: "event_invalid",
			sourceHash,
			sourceType: candidate.sourceType,
		});
		return false;
	}
	try {
		await queueDurableServerProductEvent(event);
		await db()
			.delete(productAnalyticsReconciliationFailures)
			.where(eq(productAnalyticsReconciliationFailures.sourceHash, sourceHash));
		return true;
	} catch {
		await recordReconciliationFailure({
			errorCode: "queue_failed",
			sourceHash,
			sourceType: candidate.sourceType,
		});
		return false;
	}
}

async function reconcileCandidates(candidates: ReconciliationCandidate[]) {
	let reconciled = 0;
	let failed = 0;
	for (
		let offset = 0;
		offset < candidates.length;
		offset += RECONCILIATION_ENQUEUE_CONCURRENCY
	) {
		const results = await Promise.all(
			candidates
				.slice(offset, offset + RECONCILIATION_ENQUEUE_CONCURRENCY)
				.map(reconcileCandidate),
		);
		reconciled += results.filter(Boolean).length;
		failed += results.filter((result) => !result).length;
	}
	return { failed, reconciled };
}

type ReconciliationCursor = { at: string; id: string };

export async function loadProductAnalyticsReconciliationPageStep({
	scheduledAt,
	lookbackHours,
	source,
	cursor,
}: {
	scheduledAt: string;
	lookbackHours: number;
	source: DatabaseReconciliationSource;
	cursor?: ReconciliationCursor;
}) {
	"use step";

	const { end, start } = reconciliationWindow(scheduledAt, lookbackHours);
	const cursorAt = cursor ? new Date(cursor.at) : undefined;
	if (cursorAt && !Number.isFinite(cursorAt.getTime())) {
		throw new Error("Invalid product analytics reconciliation cursor");
	}
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
	if (source === "signup") {
		const page = await db()
			.select({ id: users.id, createdAt: users.created_at })
			.from(users)
			.where(
				and(
					gte(users.created_at, start),
					lte(users.created_at, end),
					notInArray(users.id, pendingDeletionUserIds),
					cursor && cursorAt
						? or(
								gt(users.created_at, cursorAt),
								and(
									eq(users.created_at, cursorAt),
									gt(users.id, cursor.id as (typeof users.$inferSelect)["id"]),
								),
							)
						: undefined,
				),
			)
			.orderBy(asc(users.created_at), asc(users.id))
			.limit(RECONCILIATION_PAGE_SIZE);
		const result = await reconcileCandidates(
			page.map((user) => ({
				event: () =>
					userSignedUpEvent({ userId: user.id, createdAt: user.createdAt }),
				sourceId: user.id,
				sourceType: "database_signup",
			})),
		);
		const last = page.at(-1);
		return {
			...result,
			nextCursor:
				last && page.length === RECONCILIATION_PAGE_SIZE
					? { at: last.createdAt.toISOString(), id: last.id }
					: undefined,
		};
	}
	if (source === "video") {
		const page = await db()
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
					cursor && cursorAt
						? or(
								gt(videos.createdAt, cursorAt),
								and(
									eq(videos.createdAt, cursorAt),
									gt(
										videos.id,
										cursor.id as (typeof videos.$inferSelect)["id"],
									),
								),
							)
						: undefined,
				),
			)
			.orderBy(asc(videos.createdAt), asc(videos.id))
			.limit(RECONCILIATION_PAGE_SIZE);
		const result = await reconcileCandidates(
			page.map((video) => ({
				event: () => {
					const platform = videoAnalyticsPlatform(video);
					const analyticsPlatform =
						platform === "cli"
							? "cli"
							: platform === "desktop"
								? "desktop"
								: platform === "mobile"
									? "mobile"
									: "server";
					return shareLinkCreatedEvent({
						videoId: video.id,
						platform: analyticsPlatform,
						userId: video.userId,
						organizationId: video.organizationId,
						createdAt: video.createdAt,
						isScreenshot: video.isScreenshot,
						sourceType: video.source.type,
					});
				},
				sourceId: video.id,
				sourceType: "database_video",
			})),
		);
		const last = page.at(-1);
		return {
			...result,
			nextCursor:
				last && page.length === RECONCILIATION_PAGE_SIZE
					? { at: last.createdAt.toISOString(), id: last.id }
					: undefined,
		};
	}
	if (source === "comment") {
		const page = await db()
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
					cursor && cursorAt
						? or(
								gt(comments.createdAt, cursorAt),
								and(
									eq(comments.createdAt, cursorAt),
									gt(
										comments.id,
										cursor.id as (typeof comments.$inferSelect)["id"],
									),
								),
							)
						: undefined,
				),
			)
			.orderBy(asc(comments.createdAt), asc(comments.id))
			.limit(RECONCILIATION_PAGE_SIZE);
		const result = await reconcileCandidates(
			page.map((comment) => ({
				event: () =>
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
				sourceId: comment.id,
				sourceType: "database_comment",
			})),
		);
		const last = page.at(-1);
		return {
			...result,
			nextCursor:
				last && page.length === RECONCILIATION_PAGE_SIZE
					? { at: last.createdAt.toISOString(), id: last.id }
					: undefined,
		};
	}
	const page = await db()
		.select({
			id: videos.id,
			userId: videos.ownerId,
			organizationId: videos.orgId,
			firstExternalViewAt: videos.firstExternalViewAt,
		})
		.from(videos)
		.where(
			and(
				isNotNull(videos.firstExternalViewAt),
				gte(videos.firstExternalViewAt, start),
				lte(videos.firstExternalViewAt, end),
				notInArray(videos.ownerId, pendingDeletionUserIds),
				cursor && cursorAt
					? or(
							gt(videos.firstExternalViewAt, cursorAt),
							and(
								eq(videos.firstExternalViewAt, cursorAt),
								gt(videos.id, cursor.id as (typeof videos.$inferSelect)["id"]),
							),
						)
					: undefined,
			),
		)
		.orderBy(asc(videos.firstExternalViewAt), asc(videos.id))
		.limit(RECONCILIATION_PAGE_SIZE);
	const result = await reconcileCandidates(
		page.map((video) => ({
			event: () => {
				if (!video.firstExternalViewAt) {
					throw new Error("First-view reconciliation timestamp is missing");
				}
				return firstViewReceivedEvent({
					videoId: video.id,
					userId: video.userId,
					organizationId: video.organizationId,
					createdAt: video.firstExternalViewAt,
				});
			},
			sourceId: video.id,
			sourceType: "database_first_view",
		})),
	);
	const last = page.at(-1);
	return {
		...result,
		nextCursor:
			last?.firstExternalViewAt && page.length === RECONCILIATION_PAGE_SIZE
				? { at: last.firstExternalViewAt.toISOString(), id: last.id }
				: undefined,
	};
}
loadProductAnalyticsReconciliationPageStep.maxRetries = 4;

export async function loadProductAnalyticsReconciliationEventsStep(input: {
	scheduledAt: string;
	lookbackHours: number;
}) {
	let reconciled = 0;
	let failed = 0;
	for (const source of ["signup", "video", "comment", "first_view"] as const) {
		let cursor: ReconciliationCursor | undefined;
		for (let pageNumber = 0; ; pageNumber += 1) {
			if (pageNumber >= MAX_RECONCILIATION_PAGES_PER_SOURCE) {
				throw new Error("Product analytics reconciliation page limit exceeded");
			}
			const page = await loadProductAnalyticsReconciliationPageStep({
				...input,
				source,
				cursor,
			});
			reconciled += page.reconciled;
			failed += page.failed;
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
	}
	return { failed, reconciled };
}

async function reconcileStripeAnalyticsEventBatch(
	stripeEvents: Stripe.Event[],
) {
	const sessions = stripeEvents
		.filter(({ type }) => type.startsWith("checkout.session."))
		.map((event) => ({
			event,
			session: event.data.object as Stripe.Checkout.Session,
		}))
		.filter(({ session }) => session.metadata?.type !== "developer_credits");
	const subscriptionEvents = stripeEvents
		.filter(({ type }) => type.startsWith("customer.subscription."))
		.map((event) => ({
			event,
			subscription: event.data.object as Stripe.Subscription,
		}));
	const invoiceEvents = stripeEvents
		.filter(
			({ type }) =>
				type === "invoice.paid" || type === "invoice.payment_failed",
		)
		.map((event) => ({
			event,
			invoice: event.data.object as Stripe.Invoice,
		}));
	const refundEvents = stripeEvents
		.filter(({ type }) => type === "charge.refunded")
		.map((event) => ({
			event,
			charge: event.data.object as Stripe.Charge,
		}));
	const customerIds = [
		...new Set(
			[
				...sessions.map(({ session }) => session.customer),
				...subscriptionEvents.map(({ subscription }) => subscription.customer),
				...invoiceEvents.map(({ invoice }) => invoice.customer),
				...refundEvents.map(({ charge }) => charge.customer),
			].flatMap((customer) => {
				if (typeof customer === "string") return [customer];
				return customer?.id ? [customer.id] : [];
			}),
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
	const getUser = (
		customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
	) => {
		const customerId = typeof customer === "string" ? customer : customer?.id;
		if (!customerId) throw new Error("Stripe event is missing a customer");
		const user = usersByCustomerId.get(customerId);
		if (!user) throw new Error("Stripe event has no matching analytics user");
		return user;
	};
	for (const { event, subscription } of subscriptionEvents.filter(
		({ event }) => event.type === "customer.subscription.created",
	)) {
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
	for (const { event, subscription } of subscriptionEvents.filter(
		({ event }) => event.type === "customer.subscription.updated",
	)) {
		const user = getUser(subscription.customer);
		const previous = event.data.previous_attributes as
			| Partial<Stripe.Subscription>
			| undefined;
		const occurredAt = new Date(event.created * 1_000).toISOString();
		const trialConverted = subscriptionTrialConvertedProductEvent({
			eventId: event.id,
			occurredAt,
			subscription,
			previousStatus: previous?.status,
			user,
		});
		if (trialConverted) reconciled.push(trialConverted);
		reconciled.push(
			...subscriptionChangedProductEvents({
				eventId: event.id,
				occurredAt,
				subscription,
				previous,
				user,
			}),
		);
	}
	for (const { event, subscription } of subscriptionEvents.filter(
		({ event }) => event.type === "customer.subscription.deleted",
	)) {
		reconciled.push(
			subscriptionCancelledProductEvent({
				eventId: event.id,
				occurredAt: new Date(event.created * 1_000).toISOString(),
				subscription,
				user: getUser(subscription.customer),
			}),
		);
	}
	for (const { event, invoice } of invoiceEvents) {
		if (!invoice.subscription) continue;
		const subscriptionId =
			typeof invoice.subscription === "string"
				? invoice.subscription
				: invoice.subscription.id;
		const user = getUser(invoice.customer);
		const occurredAt = new Date(event.created * 1_000).toISOString();
		if (event.type === "invoice.paid") {
			const productEvent = subscriptionInvoicePaidProductEvent({
				eventId: event.id,
				occurredAt,
				invoice,
				user,
				firstPositivePayment: await isFirstPositiveSubscriptionPayment({
					invoice,
					subscriptionId,
					listPaidInvoices: (input) => stripe().invoices.list(input),
				}),
			});
			if (productEvent) reconciled.push(productEvent);
			continue;
		}
		const productEvent = subscriptionPaymentFailedProductEvent({
			eventId: event.id,
			occurredAt,
			invoice,
			user,
		});
		if (productEvent) reconciled.push(productEvent);
	}
	for (const { event, charge } of refundEvents) {
		if (!charge.invoice) continue;
		const invoice =
			typeof charge.invoice === "string"
				? await stripe().invoices.retrieve(charge.invoice)
				: charge.invoice;
		if (!invoice.subscription) continue;
		const previous = event.data.previous_attributes as
			| Partial<Stripe.Charge>
			| undefined;
		const productEvent = subscriptionRefundedProductEvent({
			eventId: event.id,
			occurredAt: new Date(event.created * 1_000).toISOString(),
			charge,
			invoice,
			user: getUser(charge.customer),
			refundedAmount: charge.amount_refunded - (previous?.amount_refunded ?? 0),
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
								: session.metadata?.platform === "cli"
									? "cli"
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
	const delivery = await reconcileCandidates(
		reconciled.map((event) => ({
			event: () => event,
			sourceId: event.eventId,
			sourceType: "stripe_event",
		})),
	);
	return {
		failed: delivery.failed,
		reconciled: delivery.reconciled,
		legacyStripeEventsSkipped,
	};
}

export async function loadStripeAnalyticsReconciliationPageStep({
	scheduledAt,
	lookbackHours,
	type,
	startingAfter,
}: {
	scheduledAt: string;
	lookbackHours: number;
	type: (typeof STRIPE_ANALYTICS_EVENT_TYPES)[number];
	startingAfter?: string;
}) {
	"use step";

	const { end, start } = reconciliationWindow(scheduledAt, lookbackHours);
	let reconciled = 0;
	let failed = 0;
	let legacyStripeEventsSkipped = 0;
	const page = await stripe().events.list({
		type,
		created: {
			gte: Math.floor(start.getTime() / 1_000),
			lte: Math.floor(end.getTime() / 1_000),
		},
		limit: 100,
		...(startingAfter ? { starting_after: startingAfter } : {}),
	});
	for (const event of page.data) {
		try {
			const batch = await reconcileStripeAnalyticsEventBatch([event]);
			await db()
				.delete(productAnalyticsReconciliationFailures)
				.where(
					eq(
						productAnalyticsReconciliationFailures.sourceHash,
						reconciliationSourceHash("stripe_event", event.id),
					),
				);
			reconciled += batch.reconciled;
			failed += batch.failed;
			legacyStripeEventsSkipped += batch.legacyStripeEventsSkipped;
		} catch {
			await recordReconciliationFailure({
				errorCode: "event_invalid",
				sourceHash: reconciliationSourceHash("stripe_event", event.id),
				sourceType: "stripe_event",
			});
			failed += 1;
		}
	}
	const nextStartingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
	if (page.has_more && !nextStartingAfter) {
		throw new Error("Stripe analytics reconciliation pagination failed");
	}
	return {
		failed,
		legacyStripeEventsSkipped,
		nextStartingAfter,
		reconciled,
	};
}
loadStripeAnalyticsReconciliationPageStep.maxRetries = 4;

export async function loadStripeAnalyticsReconciliationEventsStep(input: {
	scheduledAt: string;
	lookbackHours: number;
}) {
	let reconciled = 0;
	let failed = 0;
	let legacyStripeEventsSkipped = 0;
	for (const type of STRIPE_ANALYTICS_EVENT_TYPES) {
		let startingAfter: string | undefined;
		for (let pageNumber = 0; ; pageNumber += 1) {
			if (pageNumber >= MAX_RECONCILIATION_PAGES_PER_SOURCE) {
				throw new Error("Stripe analytics reconciliation page limit exceeded");
			}
			const page = await loadStripeAnalyticsReconciliationPageStep({
				...input,
				type,
				startingAfter,
			});
			reconciled += page.reconciled;
			failed += page.failed;
			legacyStripeEventsSkipped += page.legacyStripeEventsSkipped;
			if (!page.nextStartingAfter) break;
			startingAfter = page.nextStartingAfter;
		}
	}
	return { failed, legacyStripeEventsSkipped, reconciled };
}

export async function reconcileProductAnalyticsWorkflow(input: {
	scheduledAt: string;
	lookbackHours: number;
}) {
	"use workflow";

	let databaseReconciled = 0;
	let databaseFailed = 0;
	for (const source of ["signup", "video", "comment", "first_view"] as const) {
		let cursor: ReconciliationCursor | undefined;
		for (let pageNumber = 0; ; pageNumber += 1) {
			if (pageNumber >= MAX_RECONCILIATION_PAGES_PER_SOURCE) {
				throw new Error("Product analytics reconciliation page limit exceeded");
			}
			const page = await loadProductAnalyticsReconciliationPageStep({
				...input,
				source,
				cursor,
			});
			databaseReconciled += page.reconciled;
			databaseFailed += page.failed;
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
	}
	let stripeReconciled = 0;
	let stripeFailed = 0;
	let legacyStripeEventsSkipped = 0;
	for (const type of STRIPE_ANALYTICS_EVENT_TYPES) {
		let startingAfter: string | undefined;
		for (let pageNumber = 0; ; pageNumber += 1) {
			if (pageNumber >= MAX_RECONCILIATION_PAGES_PER_SOURCE) {
				throw new Error("Stripe analytics reconciliation page limit exceeded");
			}
			const page = await loadStripeAnalyticsReconciliationPageStep({
				...input,
				type,
				startingAfter,
			});
			stripeReconciled += page.reconciled;
			stripeFailed += page.failed;
			legacyStripeEventsSkipped += page.legacyStripeEventsSkipped;
			if (!page.nextStartingAfter) break;
			startingAfter = page.nextStartingAfter;
		}
	}
	return {
		databaseFailed,
		databaseReconciled,
		stripeFailed,
		stripeReconciled,
		legacyStripeEventsSkipped,
	};
}
