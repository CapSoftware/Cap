import { db } from "@cap/database";
import { organizations, signedBaas, users } from "@cap/database/schema";
import {
	isProSubscription,
	STRIPE_SIGNED_BAA_PRICE_IDS,
	stripe,
} from "@cap/utils";
import type { Organisation, User } from "@cap/web-domain";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import type Stripe from "stripe";

export const BAA_ENTITLED_STATUSES = new Set([
	"active",
	"trialing",
	"past_due",
]);

export function isSignedBaaPrice(priceId: string | undefined) {
	return Boolean(
		priceId && Object.values(STRIPE_SIGNED_BAA_PRICE_IDS).includes(priceId),
	);
}

export function isSignedBaaSubscription(subscription: Stripe.Subscription) {
	return (
		subscription.metadata?.type === "signed_baa" ||
		subscription.items?.data.some((item) =>
			isSignedBaaPrice(item.price?.id),
		) === true
	);
}

export function hasPaidBaaInvoice(subscription: Stripe.Subscription) {
	const invoice = subscription.latest_invoice;
	return Boolean(
		invoice && typeof invoice !== "string" && invoice.status === "paid",
	);
}

type BaaIdentity = Pick<
	typeof signedBaas.$inferSelect,
	"id" | "organizationId" | "userId"
>;

export function hasBaaProWaiver(
	subscription: Stripe.Subscription,
	record: BaaIdentity,
) {
	return (
		BAA_ENTITLED_STATUSES.has(subscription.status) &&
		subscription.items?.data.some((item) =>
			isSignedBaaPrice(item.price?.id),
		) === true &&
		subscription.metadata?.proRequirement === "waived" &&
		subscription.metadata.baaRecordId === record.id &&
		subscription.metadata.organizationId === record.organizationId &&
		subscription.metadata.userId === record.userId
	);
}

type CheckoutOwner = {
	id: User.UserId;
	email: string;
	stripeCustomerId: string | null;
	stripeSubscriptionId: string | null;
};

export async function ensureBaaHasPro(
	owner: Pick<CheckoutOwner, "stripeCustomerId" | "stripeSubscriptionId">,
	subscription: Stripe.Subscription,
	record: BaaIdentity,
) {
	if (!isSignedBaaSubscription(subscription)) {
		throw new Error("The subscription is not a Signed BAA.");
	}
	if (hasBaaProWaiver(subscription, record)) return true;
	const proSubscription = owner.stripeSubscriptionId
		? await stripe().subscriptions.retrieve(owner.stripeSubscriptionId)
		: null;
	const proCustomerId = proSubscription
		? typeof proSubscription.customer === "string"
			? proSubscription.customer
			: proSubscription.customer.id
		: null;
	if (
		proSubscription &&
		proCustomerId === owner.stripeCustomerId &&
		isProSubscription(proSubscription) &&
		BAA_ENTITLED_STATUSES.has(proSubscription.status)
	) {
		return true;
	}
	await stripe().subscriptions.cancel(subscription.id);
	await db()
		.update(signedBaas)
		.set({ status: "canceled" })
		.where(
			and(
				eq(signedBaas.id, record.id),
				eq(signedBaas.stripeSubscriptionId, subscription.id),
			),
		);
	return false;
}

async function cancelDuplicateBaa(
	subscription: Stripe.Subscription,
	previous: typeof signedBaas.$inferSelect,
) {
	if (
		!previous.stripeSubscriptionId ||
		previous.stripeSubscriptionId === subscription.id
	)
		return false;
	const previousSubscription = await stripe().subscriptions.retrieve(
		previous.stripeSubscriptionId,
	);
	if (
		!isSignedBaaSubscription(previousSubscription) ||
		!BAA_ENTITLED_STATUSES.has(previousSubscription.status)
	)
		return false;
	await stripe().subscriptions.cancel(subscription.id);
	console.warn("Canceled duplicate Signed BAA subscription", {
		subscriptionId: subscription.id,
		existingSubscriptionId: previousSubscription.id,
	});
	return true;
}

export async function attachPaidBaaCheckout(
	session: Stripe.Checkout.Session,
	subscription: Stripe.Subscription,
	expected?: {
		owner: CheckoutOwner;
		organizationId: Organisation.OrganisationId;
	},
) {
	if (
		session.mode !== "subscription" ||
		session.status !== "complete" ||
		session.payment_status !== "paid" ||
		!isSignedBaaSubscription(subscription) ||
		!subscription.items?.data.some((item) =>
			isSignedBaaPrice(item.price?.id),
		) ||
		!BAA_ENTITLED_STATUSES.has(subscription.status)
	) {
		return null;
	}

	const customerId =
		typeof session.customer === "string"
			? session.customer
			: session.customer?.id;
	const subscriptionCustomerId =
		typeof subscription.customer === "string"
			? subscription.customer
			: subscription.customer.id;
	const subscriptionId =
		typeof session.subscription === "string"
			? session.subscription
			: session.subscription?.id;
	if (
		!customerId ||
		customerId !== subscriptionCustomerId ||
		subscriptionId !== subscription.id
	) {
		throw new Error("The checkout does not match the BAA subscription.");
	}

	const email = (
		session.customer_details?.email ??
		session.customer_email ??
		""
	)
		.trim()
		.toLowerCase();
	let owner = expected?.owner;
	if (!owner) {
		const matches = await db()
			.select()
			.from(users)
			.where(
				or(
					eq(users.stripeCustomerId, customerId),
					...(email ? [eq(users.email, email)] : []),
				),
			)
			.limit(2);
		if (matches.length !== 1) return null;
		owner = matches[0];
	}
	if (
		!owner ||
		(owner.stripeCustomerId !== customerId &&
			owner.email.toLowerCase() !== email) ||
		(subscription.metadata?.userId && subscription.metadata.userId !== owner.id)
	) {
		throw new Error("This BAA payment belongs to a different account.");
	}

	const linked = await db()
		.select()
		.from(signedBaas)
		.where(eq(signedBaas.stripeSubscriptionId, subscription.id))
		.limit(2);
	const records = linked.length
		? linked
		: await db()
				.select()
				.from(signedBaas)
				.where(
					and(
						eq(signedBaas.userId, owner.id),
						isNull(signedBaas.stripeSubscriptionId),
						eq(signedBaas.status, "pending"),
						...(subscription.metadata?.organizationId
							? [
									eq(
										signedBaas.organizationId,
										subscription.metadata
											.organizationId as Organisation.OrganisationId,
									),
								]
							: []),
					),
				)
				.limit(2);
	const record = records[0];
	if (records.length !== 1 || !record) {
		if (records.length !== 0) return null;
		const organizationId =
			expected?.organizationId ?? subscription.metadata?.organizationId;
		const existing = await db()
			.select()
			.from(signedBaas)
			.where(
				and(
					eq(signedBaas.userId, owner.id),
					ne(signedBaas.status, "canceled"),
					...(organizationId
						? [
								eq(
									signedBaas.organizationId,
									organizationId as Organisation.OrganisationId,
								),
							]
						: []),
				),
			)
			.limit(2);
		const previous = existing[0];
		if (
			existing.length !== 1 ||
			!previous?.stripeSubscriptionId ||
			previous.stripeSubscriptionId === subscription.id
		)
			return null;
		const [organization] = await db()
			.select({ ownerId: organizations.ownerId })
			.from(organizations)
			.where(eq(organizations.id, previous.organizationId))
			.limit(1);
		if (organization?.ownerId !== owner.id) return null;
		return (await cancelDuplicateBaa(subscription, previous)) ? previous : null;
	}
	if (
		record.userId !== owner.id ||
		(expected && record.organizationId !== expected.organizationId) ||
		(subscription.metadata?.organizationId &&
			record.organizationId !== subscription.metadata.organizationId)
	) {
		throw new Error("This BAA payment belongs to a different organization.");
	}
	const [organization] = await db()
		.select({ ownerId: organizations.ownerId })
		.from(organizations)
		.where(eq(organizations.id, record.organizationId))
		.limit(1);
	if (organization?.ownerId !== owner.id) {
		throw new Error("Only the organization owner can confirm the BAA payment.");
	}
	if (record.status === "canceled") return null;
	let attached = record;
	if (record.stripeSubscriptionId !== subscription.id) {
		await db()
			.update(signedBaas)
			.set({ stripeSubscriptionId: subscription.id })
			.where(
				and(
					eq(signedBaas.id, record.id),
					eq(signedBaas.status, "pending"),
					isNull(signedBaas.stripeSubscriptionId),
				),
			);
		const [result] = await db()
			.select()
			.from(signedBaas)
			.where(eq(signedBaas.id, record.id))
			.limit(1);
		if (result?.stripeSubscriptionId !== subscription.id) {
			if (result && (await cancelDuplicateBaa(subscription, result)))
				return result;
			throw new Error(
				"The BAA changed while confirming payment. Please refresh or contact support.",
			);
		}
		attached = result;
	}

	// Link before checking Pro so a concurrent Pro cancellation can find this
	// subscription even when Checkout created a different Stripe customer.
	if (!(await ensureBaaHasPro(owner, subscription, record))) {
		return null;
	}
	if (attached.status !== "pending") return attached;

	await db()
		.update(signedBaas)
		.set({ status: "paid" })
		.where(
			and(
				eq(signedBaas.id, record.id),
				eq(signedBaas.status, "pending"),
				eq(signedBaas.stripeSubscriptionId, subscription.id),
			),
		);
	const [confirmed] = await db()
		.select()
		.from(signedBaas)
		.where(eq(signedBaas.id, record.id))
		.limit(1);
	if (confirmed?.stripeSubscriptionId !== subscription.id) {
		throw new Error(
			"The BAA changed while confirming payment. Please refresh or contact support.",
		);
	}
	return confirmed;
}
