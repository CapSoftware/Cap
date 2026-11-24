import { serverEnv } from "@cap/env";
import { isProSubscription, STRIPE_PLAN_IDS, stripe } from "@cap/utils";
import type Stripe from "stripe";
import { CODE, ENDS_AT } from "@/components/pages/blackfriday/content";

export const CAP_FRIDAY_CODE = CODE;
export const CAP_FRIDAY_COUPON_ID = "CAP_FRIDAY_2026_EXISTING";
export const CAP_FRIDAY_SWITCH_COUPON_ID = "CAP_FRIDAY_2026_SWITCH";
const CAP_FRIDAY_COUPONS = new Set([
	CAP_FRIDAY_COUPON_ID,
	CAP_FRIDAY_SWITCH_COUPON_ID,
]);
export const CAP_FRIDAY_INVOICE_KEY = "capFriday2026Invoice";
export const CAP_FRIDAY_METADATA = "capFriday2026";
const CREDIT_TXN_KEY = "capFridayCreditTxn";
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
	CAP_FRIDAY_COUPONS.has(invoice.discount?.coupon?.id ?? "") ||
	(invoice.discounts ?? []).some(
		(discount) =>
			typeof discount !== "string" &&
			!discount.deleted &&
			CAP_FRIDAY_COUPONS.has(discount.coupon?.id ?? ""),
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
	// Half of an odd amount could round differently from Stripe's coupon, and
	// the claim refuses any total that differs from the quote.
	if (renewalAmount <= 0 || renewalAmount % 2 !== 0) return null;
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
		coupon: CAP_FRIDAY_SWITCH_COUPON_ID,
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

// A switch keeps its discount for the whole first year: with a one-off
// coupon, a seat added mid-year credits the discounted price but re-bills
// every seat at full price for the rest of the year.
const COUPONS = [
	{ id: CAP_FRIDAY_COUPON_ID, duration: "once" as const },
	{
		id: CAP_FRIDAY_SWITCH_COUPON_ID,
		duration: "repeating" as const,
		duration_in_months: 12,
	},
];

let couponsReady: Promise<void> | null = null;

function ensureCoupon() {
	couponsReady ??= Promise.all(
		COUPONS.map(async (coupon) => {
			try {
				await stripe().coupons.retrieve(coupon.id);
			} catch (error) {
				if ((error as { code?: string }).code !== "resource_missing") {
					throw error;
				}
				await stripe().coupons.create(
					{ ...coupon, name: "Cap Friday, 50% off", percent_off: 50 },
					{ idempotencyKey: `coupon-${coupon.id}` },
				);
			}
		}),
	).then(
		() => undefined,
		(error) => {
			couponsReady = null;
			throw error;
		},
	);
	return couponsReady;
}

type Loaded =
	| { state: CapFridayState }
	| {
			subscription: Stripe.Subscription;
			customer: Stripe.Customer;
			card: CapFridayCard;
			paymentMethodId: string;
	  };

const missingAsNull = (error: unknown) => {
	if ((error as { code?: string }).code === "resource_missing") return null;
	throw error;
};

async function load(owner: Owner): Promise<Loaded> {
	if (!capFridayLive()) return { state: unavailable("ended") };
	const customerId = owner.stripeCustomerId;
	if (!customerId) return { state: unavailable("not_owner") };
	const [subscription, customer, others] = await Promise.all([
		loadSubscription(owner),
		stripe().customers.retrieve(customerId).catch(missingAsNull),
		stripe()
			.subscriptions.list({ customer: customerId, status: "all", limit: 20 })
			.catch(missingAsNull),
	]);
	if (!subscription || !customer || customer.deleted || !others) {
		return { state: unavailable("not_owner") };
	}

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
	const [loaded] = await Promise.all([load(owner), ensureCoupon()]);
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
	// request may already have paid. Paying a draft finalizes it in the same
	// call, so the amount is checked on the draft first.
	const draft = await stripe().invoices.retrieve(invoice.id);
	if (draft.status === "void") return { ok: false, message: CHANGED };
	if (draft.status === "draft" && draft.total !== quote.dueToday) {
		await stripe().invoices.del(invoice.id);
		return { ok: false, message: CHANGED };
	}

	await stripe().customers.update(customer.id, {
		metadata: { [CAP_FRIDAY_INVOICE_KEY]: invoice.id },
	});
	const paid = await stripe()
		.invoices.pay(invoice.id, { off_session: true })
		.catch(() => stripe().invoices.retrieve(invoice.id));
	if (paid.status !== "paid") {
		if (paid.hosted_invoice_url) {
			return { ok: false, payUrl: paid.hosted_invoice_url };
		}
		return { ok: false, message: DECLINED };
	}
	try {
		await grantCapFridayCredit(paid, { justPaid: true });
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
		coupon: CAP_FRIDAY_SWITCH_COUPON_ID,
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

export async function grantCapFridayCredit(
	invoice: Stripe.Invoice,
	options: { justPaid?: boolean } = {},
) {
	if (invoice.metadata?.[CAP_FRIDAY_METADATA] !== "prepay") return;
	if (invoice.status !== "paid") return;
	const current = options.justPaid
		? invoice
		: await stripe().invoices.retrieve(invoice.id);
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

// Stripe rejects a request while another one with the same idempotency key is
// still in flight; once that finishes, a retry returns its stored result.
async function withIdempotencyRetry<T>(request: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await request();
		} catch (error) {
			const conflict =
				(error as { statusCode?: number }).statusCode === 409 ||
				(error as { type?: string }).type === "StripeIdempotencyError";
			if (!conflict || attempt >= 4) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
		}
	}
}

const postedAmount = (invoice: Stripe.Invoice, key: string) => {
	const amount = Number(invoice.metadata?.[key]?.split(":")[1]);
	return Number.isFinite(amount) ? amount : 0;
};

export type CapFridayReversal = "none" | "reversed" | "awaiting_grant";

export async function reverseCapFridayCredit(
	source: Stripe.Charge | Stripe.Dispute | Stripe.Refund,
): Promise<CapFridayReversal> {
	const linked = source.object === "charge" ? null : source.charge;
	const charge =
		source.object === "charge"
			? source
			: typeof linked === "string"
				? await stripe().charges.retrieve(linked)
				: linked;
	if (!charge) return "none";
	const invoiceId =
		typeof charge.invoice === "string" ? charge.invoice : charge.invoice?.id;
	if (!invoiceId) return "none";
	const invoice = await stripe().invoices.retrieve(invoiceId);
	if (invoice.metadata?.[CAP_FRIDAY_METADATA] !== "prepay") return "none";
	if (!invoice.metadata?.[CREDIT_TXN_KEY]) return "awaiting_grant";
	const credit = Number(invoice.metadata.creditAmount);
	if (!Number.isInteger(credit) || credit <= 0 || charge.amount <= 0) {
		return "reversed";
	}
	const customerId =
		typeof invoice.customer === "string"
			? invoice.customer
			: invoice.customer?.id;
	if (!customerId) {
		throw new Error(`Cap Friday invoice ${invoice.id} has no customer`);
	}

	// Each slice belongs to one refund or dispute and is derived only from the
	// charge's refund history, so concurrent webhooks compute the same slices
	// and the same idempotency keys instead of racing on a running total. A
	// refund that fails after its slice was posted gets that slice undone, so
	// a later dispute never takes back more than the credit.
	const refunds = await stripe()
		.refunds.list({ charge: charge.id, limit: 100 })
		.autoPagingToArray({ limit: 1000 });
	const live = (refund: Stripe.Refund) =>
		refund.status !== "failed" && refund.status !== "canceled";
	const slices: { id: string; amount: number; key: string; label: string }[] =
		[];
	let refunded = 0;
	for (const refund of refunds
		.filter(live)
		.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))) {
		const before = Math.round((credit * refunded) / charge.amount);
		refunded = Math.min(charge.amount, refunded + refund.amount);
		const after = Math.round((credit * refunded) / charge.amount);
		slices.push({
			id: refund.id,
			amount: after - before,
			key: `cfRev_${refund.id}`,
			label: "after a refund",
		});
	}
	const counted = slices.reduce((total, slice) => total + slice.amount, 0);
	const failed = refunds.filter((refund) => !live(refund));
	// The dispute state comes from Stripe, not from our own markers, so a
	// zero-amount or concurrently posted dispute slice can't be missed. On a
	// disputed charge the dispute owns whatever refunds don't, including slices
	// already posted for refunds that later failed, so nothing is undone.
	const { disputed } = await stripe().charges.retrieve(charge.id);
	if (!disputed && source.object !== "dispute") {
		for (const refund of failed) {
			const posted = postedAmount(invoice, `cfRev_${refund.id}`);
			if (posted > 0) {
				slices.push({
					id: `${refund.id}-undo`,
					amount: -posted,
					key: `cfUnrev_${refund.id}`,
					label: "restored after a refund failed",
				});
			}
		}
	}
	if (source.object === "dispute") {
		const stranded = failed.reduce(
			(total, refund) =>
				invoice.metadata?.[`cfUnrev_${refund.id}`]
					? total
					: total + postedAmount(invoice, `cfRev_${refund.id}`),
			0,
		);
		slices.push({
			id: source.id,
			amount: Math.max(0, credit - counted - stranded),
			key: `cfDisp_${source.id}`,
			label: "after a dispute",
		});
	}

	for (const slice of slices) {
		if (slice.amount === 0 || invoice.metadata?.[slice.key]) continue;
		const transaction = await withIdempotencyRetry(() =>
			stripe().customers.createBalanceTransaction(
				customerId,
				{
					amount: slice.amount,
					currency: invoice.currency,
					description: `Cap Friday: prepaid renewal credit ${slice.amount > 0 ? "reversed" : "restored"} ${slice.label} (invoice ${invoice.number ?? invoice.id})`,
					metadata: {
						[CAP_FRIDAY_METADATA]: "reversal",
						invoiceId: invoice.id,
						sourceId: slice.id,
					},
				},
				{ idempotencyKey: `capfriday-reverse-${slice.id}` },
			),
		);
		await stripe().invoices.update(invoice.id, {
			metadata: { [slice.key]: `${transaction.id}:${slice.amount}` },
		});
	}
	return "reversed";
}

const formatDay = (seconds: number) =>
	new Date(seconds * 1000).toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
