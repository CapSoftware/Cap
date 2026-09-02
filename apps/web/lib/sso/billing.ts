import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { organizationSso, organizations, users } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import {
	isSsoPrice,
	isSsoSubscription,
	STRIPE_SAML_SSO_PRICE_ID,
	stripe,
} from "@cap/utils";
import { Organisation, User } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import {
	isSupportedCurrency,
	SUPPORTED_CURRENCIES,
	type SupportedCurrency,
} from "@/utils/currency";

type SsoBilling = typeof organizationSso.$inferSelect;
type Transaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];
type CheckoutInput = {
	organizationId: Organisation.OrganisationId;
	purchasedByUserId: User.UserId;
	stripeCustomerId: string | null;
	currency: SupportedCurrency;
};

const TERMINAL_STATUSES = new Set(["canceled", "incomplete_expired"]);
const CHECKOUT_RETRY_LIMIT_MS = 23 * 60 * 60 * 1000;

function stripeId(value: string | { id: string } | null | undefined) {
	return typeof value === "string" ? value : (value?.id ?? null);
}

function checkoutPriceId() {
	const environment = serverEnv();
	const priceId =
		environment.STRIPE_SAML_SSO_PRICE_ID ||
		(environment.NODE_ENV === "production" ? STRIPE_SAML_SSO_PRICE_ID : null);
	if (!priceId) {
		throw new Error("SAML SSO billing is not configured. Contact support.");
	}
	return priceId;
}

function isApprovedPrice(priceId: string | undefined) {
	return Boolean(
		priceId &&
			(isSsoPrice(priceId) || priceId === serverEnv().STRIPE_SAML_SSO_PRICE_ID),
	);
}

function ssoItem(subscription: Stripe.Subscription) {
	const item = subscription.items.data[0];
	if (
		!item ||
		subscription.items.has_more ||
		subscription.items.data.length !== 1 ||
		item.quantity !== 1 ||
		!isApprovedPrice(item.price.id) ||
		item.price.recurring?.interval !== "month" ||
		item.price.recurring.interval_count !== 1
	)
		return null;
	return item;
}

function billingUrl(organizationId: Organisation.OrganisationId) {
	const url = new URL(
		"/dashboard/settings/organization/security",
		serverEnv().WEB_URL,
	);
	url.searchParams.set("organizationId", organizationId);
	return url.toString();
}

async function getOwner(organizationId: Organisation.OrganisationId) {
	const [owner] = await db()
		.select({
			id: users.id,
			stripeCustomerId: users.stripeCustomerId,
			tombstoneAt: organizations.tombstoneAt,
		})
		.from(organizations)
		.innerJoin(users, eq(organizations.ownerId, users.id))
		.where(eq(organizations.id, organizationId))
		.limit(1);
	if (!owner || owner.tombstoneAt) {
		throw new Error("Organization not found.");
	}
	return owner;
}

async function lockOrganization(
	tx: Transaction,
	organizationId: Organisation.OrganisationId,
) {
	const [organization] = await tx
		.select({
			ownerId: organizations.ownerId,
			tombstoneAt: organizations.tombstoneAt,
		})
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1)
		.for("update");
	if (!organization || organization.tombstoneAt) {
		throw new Error("Organization not found.");
	}
	return organization;
}

export async function getSsoBilling(
	organizationId: Organisation.OrganisationId,
): Promise<SsoBilling | null> {
	const [record] = await db()
		.select()
		.from(organizationSso)
		.where(eq(organizationSso.organizationId, organizationId))
		.limit(1);
	return record ?? null;
}

export async function getSsoBillingForSubscription(subscriptionId: string) {
	const [record] = await db()
		.select()
		.from(organizationSso)
		.where(eq(organizationSso.stripeSubscriptionId, subscriptionId))
		.limit(1);
	return record ?? null;
}

async function invoicePaidThrough(
	invoice: Stripe.Invoice,
	subscription: Stripe.Subscription,
	item: Stripe.SubscriptionItem,
) {
	if (
		invoice.status !== "paid" ||
		stripeId(invoice.subscription) !== subscription.id ||
		stripeId(invoice.customer) !== stripeId(subscription.customer)
	)
		return null;
	const lines = invoice.lines.has_more
		? await stripe()
				.invoices.listLineItems(invoice.id, { limit: 100 })
				.autoPagingToArray({ limit: 1000 })
		: invoice.lines.data;
	const periodEnds = lines
		.filter(
			(line) =>
				line.type === "subscription" &&
				!line.proration &&
				line.amount >= 0 &&
				line.price?.id === item.price.id &&
				stripeId(line.subscription) === subscription.id &&
				stripeId(line.subscription_item) === item.id,
		)
		.map((line) => line.period.end)
		.filter(Number.isFinite);
	if (periodEnds.length === 0) return null;
	const paidThrough = Math.min(
		Math.max(...periodEnds),
		subscription.current_period_end,
	);
	return paidThrough > 0 ? new Date(paidThrough * 1000) : null;
}

async function confirmedPaidThrough(
	subscription: Stripe.Subscription,
	item: Stripe.SubscriptionItem,
	previousPaidThrough: Date | null,
) {
	const latestInvoice =
		typeof subscription.latest_invoice === "string"
			? await stripe().invoices.retrieve(subscription.latest_invoice)
			: subscription.latest_invoice;
	if (latestInvoice) {
		const paidThrough = await invoicePaidThrough(
			latestInvoice,
			subscription,
			item,
		);
		if (paidThrough) return paidThrough;
	}
	if (subscription.status !== "active" && subscription.status !== "past_due")
		return previousPaidThrough;
	const invoices = await stripe().invoices.list({
		subscription: subscription.id,
		status: "paid",
		limit: 10,
	});
	for (const invoice of invoices.data) {
		const paidThrough = await invoicePaidThrough(invoice, subscription, item);
		if (paidThrough) return paidThrough;
	}
	return previousPaidThrough;
}

function sameBillingSnapshot(left: SsoBilling, right: SsoBilling) {
	return (
		left.stripeSubscriptionId === right.stripeSubscriptionId &&
		left.stripeCustomerId === right.stripeCustomerId &&
		left.purchasedByUserId === right.purchasedByUserId &&
		left.status === right.status &&
		left.paidThrough?.getTime() === right.paidThrough?.getTime() &&
		left.currentPeriodEnd?.getTime() === right.currentPeriodEnd?.getTime() &&
		left.cancelAtPeriodEnd === right.cancelAtPeriodEnd &&
		left.stripePriceId === right.stripePriceId
	);
}

export async function syncSsoSubscription(
	subscriptionId: string,
): Promise<SsoBilling | null> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const observed = await getSsoBillingForSubscription(subscriptionId);
		const subscription = await stripe().subscriptions.retrieve(subscriptionId, {
			expand: ["latest_invoice"],
		});
		if (!isSsoSubscription(subscription) && !observed) return null;
		const metadata = subscription.metadata;
		if (
			!observed &&
			(metadata.type !== "saml_sso" ||
				!metadata.organizationId ||
				!metadata.userId)
		)
			return null;
		const organizationId =
			observed?.organizationId ??
			Organisation.OrganisationId.make(metadata.organizationId ?? "");
		const purchasedByUserId =
			observed?.purchasedByUserId ?? User.UserId.make(metadata.userId ?? "");
		const customerId = stripeId(subscription.customer);
		if (
			!customerId ||
			(observed && observed.stripeCustomerId !== customerId) ||
			(metadata.organizationId && metadata.organizationId !== organizationId) ||
			(metadata.userId && metadata.userId !== purchasedByUserId) ||
			(metadata.type && metadata.type !== "saml_sso")
		) {
			throw new Error(
				"The SAML SSO subscription does not match its organization.",
			);
		}
		const owner = await getOwner(organizationId);
		if (
			!observed &&
			(owner.id !== purchasedByUserId || owner.stripeCustomerId !== customerId)
		) {
			throw new Error("The SAML SSO payment belongs to a different account.");
		}
		const item = ssoItem(subscription);
		if (!item && !observed) {
			throw new Error(
				"The subscription does not contain a supported SAML SSO price.",
			);
		}
		const paidThrough = item
			? await confirmedPaidThrough(
					subscription,
					item,
					observed?.paidThrough ?? null,
				)
			: null;
		const result = await db().transaction(async (tx) => {
			const organization = await lockOrganization(tx, organizationId);
			const [current] = await tx
				.select()
				.from(organizationSso)
				.where(eq(organizationSso.organizationId, organizationId))
				.limit(1)
				.for("update");
			if (
				(current?.stripeSubscriptionId === subscription.id &&
					(!observed || !sameBillingSnapshot(observed, current))) ||
				(observed &&
					current?.stripeSubscriptionId !== observed.stripeSubscriptionId)
			)
				return { retry: true } as const;
			if (!observed && organization.ownerId !== purchasedByUserId) {
				throw new Error("The organization owner changed while confirming SSO.");
			}
			if (!observed) {
				const [billingOwner] = await tx
					.select({ stripeCustomerId: users.stripeCustomerId })
					.from(users)
					.where(eq(users.id, purchasedByUserId))
					.limit(1)
					.for("update");
				if (billingOwner?.stripeCustomerId !== customerId) {
					throw new Error("The billing account changed while confirming SSO.");
				}
			}
			if (
				current?.stripeSubscriptionId &&
				current.stripeSubscriptionId !== subscription.id &&
				TERMINAL_STATUSES.has(subscription.status)
			)
				return { retry: false, record: current } as const;
			if (
				current?.stripeSubscriptionId &&
				current.stripeSubscriptionId !== subscription.id &&
				(!TERMINAL_STATUSES.has(current.status) ||
					!current.checkoutAttemptId ||
					current.checkoutAttemptId !== metadata.checkoutAttemptId)
			) {
				throw new Error(
					"A different SAML SSO subscription is already linked. Contact support; do not pay again.",
				);
			}
			if (
				current &&
				(current.purchasedByUserId !== purchasedByUserId ||
					(current.stripeCustomerId && current.stripeCustomerId !== customerId))
			) {
				throw new Error(
					"The SAML SSO purchase does not match its billing account.",
				);
			}
			if (
				current?.stripeSubscriptionId === subscription.id &&
				TERMINAL_STATUSES.has(current.status) &&
				!TERMINAL_STATUSES.has(subscription.status)
			)
				return { retry: false, record: current } as const;
			const existingPaidThrough =
				current?.stripeSubscriptionId === subscription.id
					? current.paidThrough
					: null;
			const confirmedThrough =
				paidThrough &&
				(!existingPaidThrough || paidThrough > existingPaidThrough)
					? paidThrough
					: existingPaidThrough;
			const fields = {
				purchasedByUserId,
				stripeCustomerId: customerId,
				stripeSubscriptionId: subscription.id,
				stripePriceId: subscription.items.data[0]?.price.id ?? null,
				status: item ? subscription.status : "unpaid",
				paidThrough: confirmedThrough,
				currentPeriodEnd: new Date(subscription.current_period_end * 1000),
				cancelAtPeriodEnd: subscription.cancel_at_period_end,
			};
			if (current) {
				await tx
					.update(organizationSso)
					.set(fields)
					.where(eq(organizationSso.organizationId, organizationId));
			} else {
				await tx.insert(organizationSso).values({ organizationId, ...fields });
			}
			const [record] = await tx
				.select()
				.from(organizationSso)
				.where(eq(organizationSso.organizationId, organizationId))
				.limit(1);
			if (!record) throw new Error("The SAML SSO payment could not be saved.");
			return { retry: false, record } as const;
		});
		if (!result.retry) return result.record;
	}
	throw new Error(
		"SAML SSO billing changed while synchronizing. Please retry.",
	);
}

export async function attachSsoCheckout(
	sessionId: string,
	expected?: {
		organizationId: Organisation.OrganisationId;
		userId: User.UserId;
	},
): Promise<SsoBilling | null> {
	if (!sessionId.startsWith("cs_") || sessionId.length > 255) {
		throw new Error("Invalid SAML SSO payment confirmation.");
	}
	if (
		expected &&
		(await getOwner(expected.organizationId)).id !== expected.userId
	) {
		throw new Error(
			"Only the organization owner can confirm SAML SSO billing.",
		);
	}
	const session = await stripe().checkout.sessions.retrieve(sessionId);
	if (
		session.mode !== "subscription" ||
		session.status !== "complete" ||
		session.payment_status !== "paid"
	)
		return null;
	const subscriptionId = stripeId(session.subscription);
	if (!subscriptionId) throw new Error("No SAML SSO subscription was found.");
	const subscription = await stripe().subscriptions.retrieve(subscriptionId);
	const binding = await getSsoBillingForSubscription(subscriptionId);
	const organizationId =
		binding?.organizationId ?? subscription.metadata.organizationId;
	const purchaserId =
		binding?.purchasedByUserId ?? subscription.metadata.userId;
	if (
		stripeId(session.customer) !== stripeId(subscription.customer) ||
		(expected &&
			(organizationId !== expected.organizationId ||
				purchaserId !== expected.userId)) ||
		(session.metadata?.organizationId &&
			session.metadata.organizationId !== organizationId) ||
		(session.metadata?.userId && session.metadata.userId !== purchaserId) ||
		(session.metadata?.type && session.metadata.type !== "saml_sso")
	) {
		throw new Error(
			"This SAML SSO payment belongs to a different organization or account.",
		);
	}
	if (!ssoItem(subscription) && !binding) return null;
	const record = await syncSsoSubscription(subscriptionId);
	return record?.stripeSubscriptionId === subscriptionId ? record : null;
}

export async function getSsoPrices(): Promise<
	{ currency: SupportedCurrency; unitAmount: number }[]
> {
	const price = await stripe().prices.retrieve(checkoutPriceId(), {
		expand: ["currency_options"],
	});
	if (
		!price.active ||
		price.recurring?.interval !== "month" ||
		price.recurring.interval_count !== 1
	) {
		throw new Error("SAML SSO billing is not available. Contact support.");
	}
	return SUPPORTED_CURRENCIES.flatMap((currency) => {
		const unitAmount =
			price.currency_options?.[currency]?.unit_amount ??
			(price.currency === currency ? price.unit_amount : null);
		return unitAmount != null && Number.isInteger(unitAmount) && unitAmount > 0
			? [{ currency, unitAmount }]
			: [];
	});
}

async function reserveCheckout(
	input: CheckoutInput & { stripeCustomerId: string },
	priceId: string,
) {
	return db().transaction(async (tx) => {
		const organization = await lockOrganization(tx, input.organizationId);
		if (organization.ownerId !== input.purchasedByUserId) {
			throw new Error("Only the organization owner can purchase SAML SSO.");
		}
		const [current] = await tx
			.select()
			.from(organizationSso)
			.where(eq(organizationSso.organizationId, input.organizationId))
			.limit(1)
			.for("update");
		if (
			current?.stripeSubscriptionId &&
			!TERMINAL_STATUSES.has(current.status)
		) {
			throw new Error(
				"SAML SSO already has a subscription. Manage its existing billing instead.",
			);
		}
		if (
			current?.stripeSubscriptionId &&
			(current.stripeCustomerId !== input.stripeCustomerId ||
				current.purchasedByUserId !== input.purchasedByUserId)
		) {
			throw new Error(
				"The previous SAML SSO subscription used a different billing account. Contact support before purchasing again.",
			);
		}
		if (current?.checkoutAttemptId) {
			if (
				current.purchasedByUserId !== input.purchasedByUserId ||
				current.stripeCustomerId !== input.stripeCustomerId ||
				!current.checkoutPriceId ||
				!isSupportedCurrency(current.checkoutCurrency) ||
				!current.checkoutStartedAt
			) {
				throw new Error(
					"An earlier SAML SSO checkout needs reconciliation. Contact support.",
				);
			}
			return current;
		}
		const fields = {
			purchasedByUserId: input.purchasedByUserId,
			stripeCustomerId: input.stripeCustomerId,
			checkoutAttemptId: randomUUID(),
			checkoutSessionId: null,
			checkoutStartedAt: new Date(),
			checkoutCurrency: input.currency,
			checkoutPriceId: priceId,
		};
		if (current) {
			await tx
				.update(organizationSso)
				.set(fields)
				.where(eq(organizationSso.organizationId, input.organizationId));
		} else {
			await tx
				.insert(organizationSso)
				.values({ organizationId: input.organizationId, ...fields });
		}
		const [reserved] = await tx
			.select()
			.from(organizationSso)
			.where(eq(organizationSso.organizationId, input.organizationId))
			.limit(1);
		if (!reserved)
			throw new Error("The SAML SSO checkout could not be reserved.");
		return reserved;
	});
}

async function saveCheckoutSession(reserved: SsoBilling, sessionId: string) {
	await db().transaction(async (tx) => {
		const organization = await lockOrganization(tx, reserved.organizationId);
		const [current] = await tx
			.select()
			.from(organizationSso)
			.where(eq(organizationSso.organizationId, reserved.organizationId))
			.limit(1)
			.for("update");
		if (
			organization.ownerId !== reserved.purchasedByUserId ||
			current?.checkoutAttemptId !== reserved.checkoutAttemptId ||
			(current.checkoutSessionId && current.checkoutSessionId !== sessionId)
		) {
			throw new Error(
				"SAML SSO billing changed during checkout. Refresh before retrying.",
			);
		}
		await tx
			.update(organizationSso)
			.set({ checkoutSessionId: sessionId })
			.where(eq(organizationSso.organizationId, reserved.organizationId));
	});
}

async function clearFinishedCheckout(reserved: SsoBilling, sessionId: string) {
	if (!reserved.checkoutAttemptId) return false;
	const attemptId = reserved.checkoutAttemptId;
	return db().transaction(async (tx) => {
		const organization = await lockOrganization(tx, reserved.organizationId);
		if (organization.ownerId !== reserved.purchasedByUserId) {
			throw new Error("The organization owner changed during checkout.");
		}
		const [current] = await tx
			.select()
			.from(organizationSso)
			.where(eq(organizationSso.organizationId, reserved.organizationId))
			.limit(1)
			.for("update");
		if (
			current?.checkoutAttemptId !== attemptId ||
			current.checkoutSessionId !== sessionId ||
			(current.stripeSubscriptionId && !TERMINAL_STATUSES.has(current.status))
		)
			return false;
		await tx
			.update(organizationSso)
			.set({
				checkoutAttemptId: null,
				checkoutSessionId: null,
				checkoutStartedAt: null,
				checkoutCurrency: null,
				checkoutPriceId: null,
			})
			.where(
				and(
					eq(organizationSso.organizationId, reserved.organizationId),
					eq(organizationSso.checkoutAttemptId, attemptId),
				),
			);
		return true;
	});
}

export async function createSsoCheckout(
	request: CheckoutInput,
): Promise<string> {
	if (!isSupportedCurrency(request.currency))
		throw new Error("Unsupported billing currency.");
	const owner = await getOwner(request.organizationId);
	if (
		owner.id !== request.purchasedByUserId ||
		(request.stripeCustomerId &&
			owner.stripeCustomerId !== request.stripeCustomerId)
	) {
		throw new Error(
			"Only the organization owner can purchase SAML SSO on this billing account.",
		);
	}
	let customerId = owner.stripeCustomerId;
	if (!customerId) {
		const customer = await stripe().customers.create(
			{ metadata: { userId: owner.id } },
			{ idempotencyKey: `cap-sso-customer-${owner.id}` },
		);
		await db()
			.update(users)
			.set({ stripeCustomerId: customer.id })
			.where(and(eq(users.id, owner.id), isNull(users.stripeCustomerId)));
		const refreshedOwner = await getOwner(request.organizationId);
		if (refreshedOwner.id !== owner.id || !refreshedOwner.stripeCustomerId) {
			throw new Error("The billing account changed. Refresh before retrying.");
		}
		customerId = refreshedOwner.stripeCustomerId;
	}
	const input = { ...request, stripeCustomerId: customerId };
	const existing = await getSsoBilling(input.organizationId);
	if (existing?.stripeSubscriptionId) {
		const current = await syncSsoSubscription(existing.stripeSubscriptionId);
		if (!current || !TERMINAL_STATUSES.has(current.status)) {
			throw new Error(
				"SAML SSO already has a subscription. Manage its existing billing instead.",
			);
		}
	}
	const subscriptions = await stripe()
		.subscriptions.list({
			customer: input.stripeCustomerId,
			status: "all",
			limit: 100,
		})
		.autoPagingToArray({ limit: 1000 });
	for (const subscription of subscriptions) {
		if (
			!isSsoSubscription(subscription) ||
			TERMINAL_STATUSES.has(subscription.status)
		)
			continue;
		if (subscription.metadata.organizationId === input.organizationId) {
			await syncSsoSubscription(subscription.id);
			throw new Error(
				"SAML SSO is already purchased for this organization. Refresh its billing settings.",
			);
		}
		if (!subscription.metadata.organizationId) {
			throw new Error(
				"An existing SAML SSO payment needs to be linked. Contact support; do not pay again.",
			);
		}
	}
	const prices = await getSsoPrices();
	if (!prices.some((price) => price.currency === input.currency)) {
		throw new Error("SAML SSO is unavailable in the selected currency.");
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		const reserved = await reserveCheckout(input, checkoutPriceId());
		let session: Stripe.Checkout.Session;
		if (reserved.checkoutSessionId) {
			session = await stripe().checkout.sessions.retrieve(
				reserved.checkoutSessionId,
			);
		} else {
			if (
				!reserved.checkoutStartedAt ||
				Date.now() - reserved.checkoutStartedAt.getTime() >=
					CHECKOUT_RETRY_LIMIT_MS
			) {
				throw new Error(
					"An earlier SAML SSO payment could not be confirmed. Contact support; do not pay again.",
				);
			}
			if (
				!reserved.checkoutAttemptId ||
				!reserved.checkoutPriceId ||
				!reserved.checkoutCurrency
			) {
				throw new Error(
					"The SAML SSO checkout is incomplete. Contact support.",
				);
			}
			const metadata = {
				type: "saml_sso",
				organizationId: reserved.organizationId,
				userId: reserved.purchasedByUserId,
				checkoutAttemptId: reserved.checkoutAttemptId,
			};
			const returnUrl = billingUrl(reserved.organizationId);
			session = await stripe().checkout.sessions.create(
				{
					mode: "subscription",
					customer: input.stripeCustomerId,
					currency: reserved.checkoutCurrency,
					line_items: [{ price: reserved.checkoutPriceId, quantity: 1 }],
					client_reference_id: reserved.organizationId,
					success_url: `${returnUrl}&sso_checkout={CHECKOUT_SESSION_ID}`,
					cancel_url: returnUrl,
					metadata,
					subscription_data: { metadata },
				},
				{ idempotencyKey: `saml-sso-checkout-${reserved.checkoutAttemptId}` },
			);
			await saveCheckoutSession(reserved, session.id);
		}
		if (
			stripeId(session.customer) !== reserved.stripeCustomerId ||
			session.currency !== reserved.checkoutCurrency ||
			session.metadata?.organizationId !== input.organizationId ||
			session.metadata.userId !== input.purchasedByUserId ||
			session.metadata.checkoutAttemptId !== reserved.checkoutAttemptId
		) {
			throw new Error(
				"The SAML SSO checkout does not match this organization.",
			);
		}
		if (
			session.status === "open" &&
			reserved.checkoutCurrency !== input.currency
		) {
			const expired = await stripe().checkout.sessions.expire(
				session.id,
				{},
				{ idempotencyKey: `saml-sso-expire-${reserved.checkoutAttemptId}` },
			);
			if (expired.id !== session.id || expired.status !== "expired") {
				throw new Error(
					"The previous currency checkout could not be closed. Refresh before retrying.",
				);
			}
			session = expired;
		}
		if (session.status === "open" && session.url) return session.url;
		if (session.status === "complete") {
			const record = await attachSsoCheckout(session.id, {
				organizationId: input.organizationId,
				userId: input.purchasedByUserId,
			});
			if (
				record &&
				TERMINAL_STATUSES.has(record.status) &&
				(await clearFinishedCheckout(reserved, session.id))
			)
				continue;
			return `${billingUrl(input.organizationId)}&sso_checkout=${encodeURIComponent(session.id)}`;
		}
		if (session.status !== "expired") {
			throw new Error(
				"The SAML SSO checkout is awaiting confirmation. Please retry shortly.",
			);
		}
		await clearFinishedCheckout(reserved, session.id);
	}
	throw new Error("The SAML SSO checkout expired. Refresh before retrying.");
}

export async function createSsoBillingPortal(
	organizationId: Organisation.OrganisationId,
): Promise<string> {
	const owner = await getOwner(organizationId);
	const record = await getSsoBilling(organizationId);
	if (
		!record?.stripeCustomerId ||
		!record.stripeSubscriptionId ||
		record.purchasedByUserId !== owner.id
	) {
		throw new Error(
			"SAML SSO billing needs to be linked to the current owner. Contact support.",
		);
	}
	const subscription = await stripe().subscriptions.retrieve(
		record.stripeSubscriptionId,
	);
	if (
		!isSsoSubscription(subscription) ||
		stripeId(subscription.customer) !== record.stripeCustomerId
	) {
		throw new Error(
			"The SAML SSO subscription does not match its billing account.",
		);
	}
	const session = await stripe().billingPortal.sessions.create({
		customer: record.stripeCustomerId,
		return_url: billingUrl(organizationId),
	});
	return session.url;
}
