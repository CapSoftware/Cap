import { serverEnv } from "@cap/env";
import { isProSubscription, STRIPE_PLAN_IDS, stripe } from "@cap/utils";
import type Stripe from "stripe";
import { CODE, ENDS_AT } from "@/components/pages/blackfriday/content";

export const CAP_FRIDAY_CODE = CODE;
export const CAP_FRIDAY_COUPON_ID = "CAP_FRIDAY_2026_EXISTING";
export const CAP_FRIDAY_INVOICE_KEY = "capFriday2026Invoice";
export const CAP_FRIDAY_METADATA = "capFriday2026";
const CREDIT_TXN_KEY = "capFridayCreditTxn";
const REVERSED_KEY = "capFridayReversed";
const QUOTE_MAX_AGE_SECONDS = 60 * 60;

export const capFridayLive = (now = Date.now()) => now < ENDS_AT;

export const isCapFridayCode = (code: string | null | undefined) =>
	typeof code === "string" && code.trim().toUpperCase() === CAP_FRIDAY_CODE;

export type CapFridayCard = { brand: string; last4: string };

export type CapFridayQuote =
	| {
			kind: "yearly";
			seats: number;
			currency: string;
			card: CapFridayCard;
			dueToday: number;
			renewsOn: number;
			renewalAmount: number;
			thenRenewsOn: number;
	  }
	| {
			kind: "monthly";
			seats: number;
			currency: string;
			card: CapFridayCard;
			dueToday: number;
			yearlyAmount: number;
			discount: number;
			unusedCredit: number;
			renewsOn: number;
			prorationDate: number;
	  };

export type CapFridayState =
	| { type: "quote"; quote: CapFridayQuote }
	| {
			type: "redeemed";
			kind: "prepay" | "switch";
			renewsOn: number | null;
	  }
	| { type: "awaiting_payment"; payUrl: string }
	| {
			type: "unavailable";
			reason:
				| "ended"
				| "not_owner"
				| "canceling"
				| "past_due"
				| "no_card"
				| "custom";
	  };

export type CapFridayRedeemResult =
	| { ok: true; kind: "prepay" | "switch"; renewsOn: number }
	| { ok: false; payUrl: string }
	| { ok: false; message: string };

type Owner = {
	stripeSubscriptionId: string | null;
	stripeCustomerId: string | null;
};

const environment = () =>
	serverEnv().VERCEL_ENV === "production" ? "production" : "development";

const yearlyPriceId = () => STRIPE_PLAN_IDS[environment()].yearly;

const unavailable = (
	reason: Extract<CapFridayState, { type: "unavailable" }>["reason"],
): CapFridayState => ({ type: "unavailable", reason });

async function loadSubscription(owner: Owner) {
	if (!owner.stripeSubscriptionId || !owner.stripeCustomerId) return null;
	const subscription = await stripe().subscriptions.retrieve(
		owner.stripeSubscriptionId,
		{ expand: ["default_payment_method", "latest_invoice.discounts"] },
	);
	const customerId =
		typeof subscription.customer === "string"
			? subscription.customer
			: subscription.customer.id;
	if (customerId !== owner.stripeCustomerId) return null;
	if (!isProSubscription(subscription)) return null;
	return subscription;
}

async function cardFor(
	subscription: Stripe.Subscription,
	customer: Stripe.Customer,
): Promise<{ card: CapFridayCard; paymentMethodId: string } | null> {
	const fromSubscription = subscription.default_payment_method;
	let method: Stripe.PaymentMethod | null =
		fromSubscription && typeof fromSubscription !== "string"
			? fromSubscription
			: null;
	const fallback = customer.invoice_settings?.default_payment_method;
	if (!method && fallback) {
		method =
			typeof fallback === "string"
				? await stripe().paymentMethods.retrieve(fallback)
				: fallback;
	}
	if (!method?.card) return null;
	return {
		card: { brand: method.card.brand, last4: method.card.last4 },
		paymentMethodId: method.id,
	};
}

function isPlainSubscription(subscription: Stripe.Subscription) {
	return (
		subscription.items.data.length === 1 &&
		!subscription.discount &&
		!subscription.schedule &&
		!subscription.automatic_tax?.enabled &&
		!(subscription.default_tax_rates?.length ?? 0) &&
		subscription.collection_method === "charge_automatically"
	);
}

const usesCapFridayCoupon = (invoice: Stripe.Invoice) =>
	invoice.discount?.coupon?.id === CAP_FRIDAY_COUPON_ID ||
	(invoice.discounts ?? []).some(
		(discount) =>
			typeof discount !== "string" &&
			!discount.deleted &&
			discount.coupon?.id === CAP_FRIDAY_COUPON_ID,
	);

async function previousRedemption(
	customer: Stripe.Customer,
	subscription: Stripe.Subscription,
): Promise<CapFridayState | null> {
	const invoiceId = customer.metadata?.[CAP_FRIDAY_INVOICE_KEY];
	// A monthly switch is charged before its metadata is written, so the
	// subscription's own latest invoice is the fallback record of it.
	const latest =
		subscription.latest_invoice &&
		typeof subscription.latest_invoice !== "string"
			? subscription.latest_invoice
			: null;
	const invoice = invoiceId
		? await stripe().invoices.retrieve(invoiceId)
		: latest && usesCapFridayCoupon(latest)
			? latest
			: null;
	if (!invoice) return null;
	const kind =
		invoice.metadata?.[CAP_FRIDAY_METADATA] === "prepay" ? "prepay" : "switch";
	if (invoice.status === "paid") {
		return {
			type: "redeemed",
			kind,
			renewsOn:
				Number(invoice.metadata?.renewsOn) ||
				(kind === "switch" ? subscription.current_period_end : null),
		};
	}
	if (invoice.status === "open" && invoice.hosted_invoice_url) {
		return { type: "awaiting_payment", payUrl: invoice.hosted_invoice_url };
	}
	return null;
}

async function quoteYearly(
	subscription: Stripe.Subscription,
	card: CapFridayCard,
): Promise<CapFridayQuote | null> {
	const customerId = subscription.customer as string;
	const upcoming = await stripe().invoices.retrieveUpcoming({
		customer: customerId,
		subscription: subscription.id,
	});
	const lines = upcoming.lines.data;
	if (
		upcoming.lines.has_more ||
		(upcoming.tax ?? 0) > 0 ||
		(upcoming.total_discount_amounts?.length ?? 0) > 0 ||
		lines.some((line) => line.type !== "subscription" || line.proration)
	) {
		return null;
	}
	const renewalAmount = lines.reduce((total, line) => total + line.amount, 0);
	if (renewalAmount <= 0) return null;
	return {
		kind: "yearly",
		seats: subscription.items.data[0]?.quantity ?? 1,
		currency: upcoming.currency,
		card,
		dueToday: Math.round(renewalAmount / 2),
		renewsOn: subscription.current_period_end,
		renewalAmount,
		thenRenewsOn: addYear(subscription.current_period_end),
	};
}

function monthlyPreviewParams(
	subscription: Stripe.Subscription,
	prorationDate: number,
) {
	const item = subscription.items.data[0];
	return {
		customer: subscription.customer as string,
		subscription: subscription.id,
		subscription_items: [
			{ id: item?.id, price: yearlyPriceId(), quantity: item?.quantity ?? 1 },
		],
		subscription_proration_behavior: "always_invoice" as const,
		subscription_proration_date: prorationDate,
		coupon: CAP_FRIDAY_COUPON_ID,
	};
}

async function quoteMonthly(
	subscription: Stripe.Subscription,
	card: CapFridayCard,
	prorationDate: number,
): Promise<CapFridayQuote | null> {
	const preview = await stripe().invoices.retrieveUpcoming(
		monthlyPreviewParams(subscription, prorationDate),
	);
	const lines = preview.lines.data;
	if (preview.lines.has_more || (preview.tax ?? 0) > 0) return null;
	const yearly = lines.filter((line) => line.amount > 0);
	const credits = lines.filter((line) => line.amount < 0);
	const yearlyLine = yearly[0];
	if (
		yearly.length !== 1 ||
		!yearlyLine ||
		yearlyLine.price?.id !== yearlyPriceId()
	) {
		return null;
	}
	const discount = (yearlyLine.discount_amounts ?? []).reduce(
		(total, entry) => total + entry.amount,
		0,
	);
	if (discount <= 0 || preview.total < 0) return null;
	return {
		kind: "monthly",
		seats: yearlyLine.quantity ?? 1,
		currency: preview.currency,
		card,
		dueToday: preview.total,
		yearlyAmount: yearlyLine.amount,
		discount,
		unusedCredit: -credits.reduce((total, line) => total + line.amount, 0),
		renewsOn: yearlyLine.period.end,
		prorationDate,
	};
}

function addYear(seconds: number) {
	const date = new Date(seconds * 1000);
	date.setUTCFullYear(date.getUTCFullYear() + 1);
	return Math.floor(date.getTime() / 1000);
}

async function ensureCoupon() {
	try {
		await stripe().coupons.retrieve(CAP_FRIDAY_COUPON_ID);
	} catch (error) {
		if ((error as { code?: string }).code !== "resource_missing") throw error;
		await stripe().coupons.create(
			{
				id: CAP_FRIDAY_COUPON_ID,
				name: "Cap Friday, 50% off",
				percent_off: 50,
				duration: "once",
			},
			{ idempotencyKey: `coupon-${CAP_FRIDAY_COUPON_ID}` },
		);
	}
}

type Loaded =
	| { state: CapFridayState }
	| {
			subscription: Stripe.Subscription;
			customer: Stripe.Customer;
			card: CapFridayCard;
			paymentMethodId: string;
	  };

async function load(owner: Owner): Promise<Loaded> {
	if (!capFridayLive()) return { state: unavailable("ended") };
	const subscription = await loadSubscription(owner);
	if (!subscription) return { state: unavailable("not_owner") };
	const customer = await stripe().customers.retrieve(
		subscription.customer as string,
	);
	if (customer.deleted) return { state: unavailable("not_owner") };

	const previous = await previousRedemption(customer, subscription);
	if (previous) return { state: previous };

	if (subscription.status === "past_due") {
		return { state: unavailable("past_due") };
	}
	if (subscription.status !== "active") {
		return { state: unavailable("custom") };
	}
	if (subscription.cancel_at_period_end || subscription.cancel_at) {
		return { state: unavailable("canceling") };
	}
	// Existing account credit would quietly change what's charged today.
	if (!isPlainSubscription(subscription) || customer.balance !== 0) {
		return { state: unavailable("custom") };
	}
	// Account credit is shared by every subscription on the customer, so a
	// separate SSO or BAA bill would spend the prepaid renewal first.
	const others = await stripe().subscriptions.list({
		customer: customer.id,
		status: "all",
		limit: 20,
	});
	if (
		others.data.some(
			(other) =>
				other.id !== subscription.id &&
				!["canceled", "incomplete_expired"].includes(other.status),
		)
	) {
		return { state: unavailable("custom") };
	}
	const payment = await cardFor(subscription, customer);
	if (!payment) return { state: unavailable("no_card") };
	return { subscription, customer, ...payment };
}

const interval = (subscription: Stripe.Subscription) =>
	subscription.items.data[0]?.price.recurring?.interval;

export async function getCapFridayState(owner: Owner): Promise<CapFridayState> {
	const loaded = await load(owner);
	if ("state" in loaded) return loaded.state;
	const { subscription, card } = loaded;

	let quote: CapFridayQuote | null = null;
	if (interval(subscription) === "year") {
		quote = await quoteYearly(subscription, card);
	} else if (interval(subscription) === "month") {
		await ensureCoupon();
		quote = await quoteMonthly(
			subscription,
			card,
			Math.floor(Date.now() / 1000),
		);
	}
	return quote ? { type: "quote", quote } : unavailable("custom");
}

const CHANGED =
	"Your plan changed since this page loaded. Refresh to see the latest price.";
const DECLINED =
	"Your card was declined. Update it in billing settings, then try again.";

export async function redeemCapFriday(
	owner: Owner,
	input: { dueToday: number; prorationDate?: number },
): Promise<CapFridayRedeemResult> {
	const loaded = await load(owner);
	if ("state" in loaded) {
		const { state } = loaded;
		if (state.type === "redeemed") {
			return { ok: true, kind: state.kind, renewsOn: state.renewsOn ?? 0 };
		}
		if (state.type === "awaiting_payment") {
			return { ok: false, payUrl: state.payUrl };
		}
		return { ok: false, message: CHANGED };
	}
	const { subscription, customer, card, paymentMethodId } = loaded;
	await ensureCoupon();

	if (interval(subscription) === "year") {
		const quote = await quoteYearly(subscription, card);
		if (quote?.kind !== "yearly" || quote.dueToday !== input.dueToday) {
			return { ok: false, message: CHANGED };
		}
		return prepayYearly(subscription, customer, quote, paymentMethodId);
	}

	const now = Math.floor(Date.now() / 1000);
	const prorationDate = input.prorationDate ?? 0;
	if (prorationDate > now || now - prorationDate > QUOTE_MAX_AGE_SECONDS) {
		return { ok: false, message: CHANGED };
	}
	const quote = await quoteMonthly(subscription, card, prorationDate);
	if (quote?.kind !== "monthly" || quote.dueToday !== input.dueToday) {
		return { ok: false, message: CHANGED };
	}
	return switchMonthly(subscription, quote);
}

async function prepayYearly(
	subscription: Stripe.Subscription,
	customer: Stripe.Customer,
	quote: Extract<CapFridayQuote, { kind: "yearly" }>,
	paymentMethodId: string,
): Promise<CapFridayRedeemResult> {
	const key = `capfriday-${subscription.id}-${subscription.current_period_end}`;
	const metadata = {
		[CAP_FRIDAY_METADATA]: "prepay",
		subscriptionId: subscription.id,
		creditAmount: String(quote.renewalAmount),
		renewsOn: String(quote.renewsOn),
	};
	const invoice = await stripe().invoices.create(
		{
			customer: customer.id,
			currency: quote.currency,
			collection_method: "charge_automatically",
			default_payment_method: paymentMethodId,
			auto_advance: false,
			pending_invoice_items_behavior: "exclude",
			description: `Covers your Cap Pro renewal on ${formatDay(quote.renewsOn)}. That renewal is paid from your account credit, then Cap Pro renews as normal on ${formatDay(quote.thenRenewsOn)}.`,
			metadata,
		},
		{ idempotencyKey: `${key}-invoice` },
	);
	await stripe().invoiceItems.create(
		{
			customer: customer.id,
			invoice: invoice.id,
			currency: quote.currency,
			amount: quote.renewalAmount,
			description: `Cap Pro yearly, ${quote.seats} ${quote.seats === 1 ? "seat" : "seats"}, prepaid for the year from ${formatDay(quote.renewsOn)}`,
			discounts: [{ coupon: CAP_FRIDAY_COUPON_ID }],
			metadata,
		},
		{ idempotencyKey: `${key}-item` },
	);
	// A second click replays the same idempotent invoice, which the first
	// request may already have finalized or paid.
	const finalized = await stripe()
		.invoices.finalizeInvoice(invoice.id)
		.catch(async (error) => {
			const current = await stripe().invoices.retrieve(invoice.id);
			if (current.status === "draft") throw error;
			return current;
		});
	if (finalized.status === "void") return { ok: false, message: CHANGED };
	if (finalized.total !== quote.dueToday) {
		await stripe().invoices.voidInvoice(invoice.id);
		return { ok: false, message: CHANGED };
	}
	await stripe().customers.update(customer.id, {
		metadata: { [CAP_FRIDAY_INVOICE_KEY]: invoice.id },
	});

	let paid: Stripe.Invoice;
	try {
		paid = await stripe().invoices.pay(invoice.id, { off_session: true });
	} catch {
		paid = await stripe().invoices.retrieve(invoice.id);
	}
	if (paid.status !== "paid") {
		if (paid.hosted_invoice_url) {
			return { ok: false, payUrl: paid.hosted_invoice_url };
		}
		return { ok: false, message: DECLINED };
	}
	try {
		await grantCapFridayCredit(paid);
	} catch (error) {
		console.error("Cap Friday credit not granted yet, webhook retries it", {
			invoiceId: paid.id,
			error,
		});
	}
	return { ok: true, kind: "prepay", renewsOn: quote.renewsOn };
}

async function switchMonthly(
	subscription: Stripe.Subscription,
	quote: Extract<CapFridayQuote, { kind: "monthly" }>,
): Promise<CapFridayRedeemResult> {
	const item = subscription.items.data[0];
	if (!item) return { ok: false, message: CHANGED };
	const updated = await stripe().subscriptions.update(subscription.id, {
		items: [{ id: item.id, price: yearlyPriceId(), quantity: quote.seats }],
		proration_behavior: "always_invoice",
		proration_date: quote.prorationDate,
		payment_behavior: "pending_if_incomplete",
		coupon: CAP_FRIDAY_COUPON_ID,
		expand: ["latest_invoice"],
	});
	const invoice = updated.latest_invoice as Stripe.Invoice | null;
	if (invoice) {
		try {
			await stripe().invoices.update(invoice.id, {
				metadata: {
					[CAP_FRIDAY_METADATA]: "switch",
					renewsOn: String(quote.renewsOn),
				},
			});
			await stripe().customers.update(subscription.customer as string, {
				metadata: { [CAP_FRIDAY_INVOICE_KEY]: invoice.id },
			});
		} catch (error) {
			console.error("Cap Friday switch recorded without metadata", {
				subscriptionId: subscription.id,
				error,
			});
		}
	}
	if (updated.pending_update) {
		if (invoice?.hosted_invoice_url) {
			return { ok: false, payUrl: invoice.hosted_invoice_url };
		}
		return { ok: false, message: DECLINED };
	}
	return { ok: true, kind: "switch", renewsOn: quote.renewsOn };
}

export async function grantCapFridayCredit(invoice: Stripe.Invoice) {
	if (invoice.metadata?.[CAP_FRIDAY_METADATA] !== "prepay") return;
	if (invoice.status !== "paid") return;
	const current = await stripe().invoices.retrieve(invoice.id);
	if (current.metadata?.[CREDIT_TXN_KEY]) return;
	const amount = Number(current.metadata?.creditAmount);
	if (!Number.isInteger(amount) || amount <= 0) {
		throw new Error(`Cap Friday invoice ${invoice.id} has no credit amount`);
	}
	const customerId =
		typeof current.customer === "string"
			? current.customer
			: current.customer?.id;
	if (!customerId)
		throw new Error(`Cap Friday invoice ${invoice.id} has no customer`);
	const transaction = await stripe().customers.createBalanceTransaction(
		customerId,
		{
			amount: -amount,
			currency: current.currency,
			description: `Cap Friday: your prepaid Cap Pro renewal (invoice ${current.number ?? current.id})`,
			metadata: { [CAP_FRIDAY_METADATA]: "credit", invoiceId: current.id },
		},
		{ idempotencyKey: `capfriday-credit-${current.id}` },
	);
	await stripe().invoices.update(current.id, {
		metadata: { [CREDIT_TXN_KEY]: transaction.id },
	});
}

export type CapFridayReversal = "none" | "reversed" | "awaiting_grant";

export async function reverseCapFridayCredit(
	source: Stripe.Charge | Stripe.Dispute,
): Promise<CapFridayReversal> {
	const charge =
		source.object === "dispute"
			? typeof source.charge === "string"
				? await stripe().charges.retrieve(source.charge)
				: source.charge
			: source;
	const invoiceId =
		typeof charge.invoice === "string" ? charge.invoice : charge.invoice?.id;
	if (!invoiceId) return "none";
	const invoice = await stripe().invoices.retrieve(invoiceId);
	if (invoice.metadata?.[CAP_FRIDAY_METADATA] !== "prepay") return "none";
	if (!invoice.metadata?.[CREDIT_TXN_KEY]) return "awaiting_grant";

	const credit = Number(invoice.metadata.creditAmount);
	const target =
		source.object === "dispute" || charge.amount <= 0
			? credit
			: Math.min(
					credit,
					Math.round((credit * charge.amount_refunded) / charge.amount),
				);
	const already = Number(invoice.metadata?.[REVERSED_KEY]) || 0;
	if (!Number.isInteger(credit) || target <= already) return "reversed";

	const customerId =
		typeof invoice.customer === "string"
			? invoice.customer
			: invoice.customer?.id;
	if (!customerId) {
		throw new Error(`Cap Friday invoice ${invoice.id} has no customer`);
	}
	await stripe().customers.createBalanceTransaction(
		customerId,
		{
			amount: target - already,
			currency: invoice.currency,
			description: `Cap Friday: prepaid renewal credit reversed after a ${source.object === "dispute" ? "dispute" : "refund"} (invoice ${invoice.number ?? invoice.id})`,
			metadata: { [CAP_FRIDAY_METADATA]: "reversal", invoiceId: invoice.id },
		},
		{ idempotencyKey: `capfriday-reverse-${invoice.id}-${target}` },
	);
	await stripe().invoices.update(invoice.id, {
		metadata: { [REVERSED_KEY]: String(target) },
	});
	return "reversed";
}

const formatDay = (seconds: number) =>
	new Date(seconds * 1000).toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
