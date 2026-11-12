import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	users,
} from "@cap/database/schema";
import { stripe } from "@cap/utils";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import { addCreditsToAccount } from "@/lib/developer-credits";
import { developerCreditsProductId } from "@/lib/developer-credits-product";
import { MICRO_CREDITS_PER_DOLLAR } from "@/lib/developer-pricing";
import { canUseInfra } from "@/lib/infra-access";
import { availableBalance } from "@/lib/infra-balance";
import { sendInfraTopUpFailedEmail } from "@/lib/infra-billing-emails";
import { utcDateKey } from "@/lib/infra-usage";

export const AUTO_TOP_UP_REFERENCE_TYPE = "auto_top_up" as const;
export const AUTO_TOP_UP_FAILED_REFERENCE_TYPE = "auto_top_up_failed" as const;
export const AUTO_TOP_UP_PENDING_REFERENCE_TYPE =
	"auto_top_up_pending" as const;
export const AUTO_TOP_UP_METADATA_TYPE = "developer_auto_top_up";
export const AUTO_TOP_UP_MIN_AMOUNT_CENTS = 500;
export const AUTO_TOP_UP_MAX_AMOUNT_CENTS = 100_000;
export const AUTO_TOP_UP_MIN_THRESHOLD_MICRO_CREDITS = MICRO_CREDITS_PER_DOLLAR;
export const AUTO_TOP_UP_MAX_THRESHOLD_MICRO_CREDITS =
	1_000 * MICRO_CREDITS_PER_DOLLAR;

const ATTEMPT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type AutoTopUpResult =
	| {
			state: "skipped";
			reason:
				| "not_found"
				| "disabled"
				| "not_allowed"
				| "no_card"
				| "invalid_settings"
				| "above_threshold"
				| "recent_attempt";
	  }
	| { state: "succeeded"; paymentIntentId: string; balanceMicroCredits: number }
	| { state: "pending"; paymentIntentId: string }
	| { state: "failed"; reason: string }
	| { state: "error" };

export function autoTopUpSettingsError({
	enabled,
	thresholdMicroCredits,
	amountCents,
	hasCard,
}: {
	enabled: boolean;
	thresholdMicroCredits: number;
	amountCents: number;
	hasCard: boolean;
}) {
	if (!enabled) return null;
	if (!hasCard) return "Save a card before switching auto top-up on";
	if (
		!Number.isSafeInteger(amountCents) ||
		amountCents < AUTO_TOP_UP_MIN_AMOUNT_CENTS ||
		amountCents > AUTO_TOP_UP_MAX_AMOUNT_CENTS
	) {
		return "Top-up amount must be between $5 and $1,000";
	}
	if (
		!Number.isSafeInteger(thresholdMicroCredits) ||
		thresholdMicroCredits < AUTO_TOP_UP_MIN_THRESHOLD_MICRO_CREDITS ||
		thresholdMicroCredits > AUTO_TOP_UP_MAX_THRESHOLD_MICRO_CREDITS
	) {
		return "Top-up threshold must be between $1 and $1,000";
	}
	return null;
}

export function autoTopUpIdempotencyKey(accountId: string, period: string) {
	return `infra-auto-top-up:${accountId}:${period}`;
}

export function autoTopUpFailureText(reason: string | null | undefined) {
	switch (reason) {
		case "authentication_required":
			return "the bank asked for a confirmation that only you can give";
		case "insufficient_funds":
			return "the card had insufficient funds";
		case "expired_card":
			return "the card has expired";
		default:
			return "the card was declined";
	}
}

function declineFrom(error: unknown) {
	if (typeof error !== "object" || error === null) return null;
	const fields = error as {
		type?: unknown;
		code?: unknown;
		decline_code?: unknown;
		payment_intent?: { id?: unknown } | null;
	};
	if (
		fields.type !== "StripeCardError" &&
		fields.type !== "StripeInvalidRequestError"
	) {
		return null;
	}
	const paymentIntentId = fields.payment_intent?.id;
	return {
		paymentIntentId:
			typeof paymentIntentId === "string" ? paymentIntentId : null,
		reason:
			(typeof fields.decline_code === "string" && fields.decline_code) ||
			(typeof fields.code === "string" && fields.code) ||
			"card_declined",
	};
}

const ATTEMPT_REFERENCE_TYPES = [
	AUTO_TOP_UP_REFERENCE_TYPE,
	AUTO_TOP_UP_FAILED_REFERENCE_TYPE,
	AUTO_TOP_UP_PENDING_REFERENCE_TYPE,
];

const SETTLED_REFERENCE_TYPES = [
	AUTO_TOP_UP_REFERENCE_TYPE,
	AUTO_TOP_UP_FAILED_REFERENCE_TYPE,
];

async function lastAttempt(
	accountId: string,
	referenceTypes: typeof ATTEMPT_REFERENCE_TYPES = ATTEMPT_REFERENCE_TYPES,
) {
	const [row] = await db()
		.select({
			type: developerCreditTransactions.type,
			createdAt: developerCreditTransactions.createdAt,
			metadata: developerCreditTransactions.metadata,
		})
		.from(developerCreditTransactions)
		.where(
			and(
				eq(developerCreditTransactions.accountId, accountId),
				inArray(developerCreditTransactions.referenceType, referenceTypes),
			),
		)
		.orderBy(desc(developerCreditTransactions.createdAt))
		.limit(1);
	return row ?? null;
}

export async function getAutoTopUpFailure(accountId: string) {
	const attempt = await lastAttempt(accountId, SETTLED_REFERENCE_TYPES);
	if (attempt?.type !== "topup_failed") return null;
	const metadata =
		typeof attempt.metadata === "object" && attempt.metadata !== null
			? (attempt.metadata as Record<string, unknown>)
			: {};
	return {
		failedAt: new Date(attempt.createdAt),
		reason: typeof metadata.reason === "string" ? metadata.reason : null,
	};
}

async function failAutoTopUp({
	accountId,
	paymentIntentId,
	reason,
	amountCents,
	period,
}: {
	accountId: string;
	paymentIntentId: string | null;
	reason: string;
	amountCents: number;
	period: string;
}) {
	const referenceId = paymentIntentId ?? `declined-${period}`;
	const recorded = await db().transaction(async (tx) => {
		const [account] = await tx
			.select({
				balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
			})
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.id, accountId))
			.limit(1)
			.for("update");
		if (!account) return false;

		const [existing] = await tx
			.select({ id: developerCreditTransactions.id })
			.from(developerCreditTransactions)
			.where(
				and(
					eq(developerCreditTransactions.accountId, accountId),
					eq(developerCreditTransactions.referenceId, referenceId),
					eq(
						developerCreditTransactions.referenceType,
						AUTO_TOP_UP_FAILED_REFERENCE_TYPE,
					),
				),
			)
			.limit(1);
		if (existing) return false;

		await tx
			.update(developerCreditAccounts)
			.set({ autoTopUpEnabled: false })
			.where(eq(developerCreditAccounts.id, accountId));

		await tx.insert(developerCreditTransactions).values({
			id: nanoId(),
			accountId,
			type: "topup_failed",
			amountMicroCredits: 0,
			balanceAfterMicroCredits: account.balanceMicroCredits,
			referenceId,
			referenceType: AUTO_TOP_UP_FAILED_REFERENCE_TYPE,
			metadata: { amountCents, reason, period },
		});
		return true;
	});

	if (recorded) {
		await sendInfraTopUpFailedEmail({ accountId, referenceId, amountCents });
	}
	return recorded;
}

async function recordPendingAutoTopUp({
	accountId,
	paymentIntentId,
	amountCents,
	period,
}: {
	accountId: string;
	paymentIntentId: string;
	amountCents: number;
	period: string;
}) {
	await db().transaction(async (tx) => {
		const [account] = await tx
			.select({
				balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
			})
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.id, accountId))
			.limit(1)
			.for("update");
		if (!account) return;

		const [existing] = await tx
			.select({ id: developerCreditTransactions.id })
			.from(developerCreditTransactions)
			.where(
				and(
					eq(developerCreditTransactions.accountId, accountId),
					eq(developerCreditTransactions.referenceId, paymentIntentId),
					inArray(
						developerCreditTransactions.referenceType,
						ATTEMPT_REFERENCE_TYPES,
					),
				),
			)
			.limit(1);
		if (existing) return;

		await tx.insert(developerCreditTransactions).values({
			id: nanoId(),
			accountId,
			type: "topup_pending",
			amountMicroCredits: 0,
			balanceAfterMicroCredits: account.balanceMicroCredits,
			referenceId: paymentIntentId,
			referenceType: AUTO_TOP_UP_PENDING_REFERENCE_TYPE,
			metadata: { amountCents, period },
		});
	});
}

function grantAutoTopUp({
	accountId,
	paymentIntentId,
	amountCents,
	period,
}: {
	accountId: string;
	paymentIntentId: string;
	amountCents: number;
	period: string | null;
}) {
	return addCreditsToAccount({
		accountId,
		amountCents,
		referenceId: paymentIntentId,
		referenceType: AUTO_TOP_UP_REFERENCE_TYPE,
		metadata: { amountCents, autoTopUp: true, period },
	});
}

export async function runAutoTopUp(
	accountId: string,
	now: Date = new Date(),
): Promise<AutoTopUpResult> {
	const [account] = await db()
		.select({
			appId: developerCreditAccounts.appId,
			balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
			stripeCustomerId: developerCreditAccounts.stripeCustomerId,
			stripePaymentMethodId: developerCreditAccounts.stripePaymentMethodId,
			autoTopUpEnabled: developerCreditAccounts.autoTopUpEnabled,
			autoTopUpThresholdMicroCredits:
				developerCreditAccounts.autoTopUpThresholdMicroCredits,
			autoTopUpAmountCents: developerCreditAccounts.autoTopUpAmountCents,
			email: users.email,
		})
		.from(developerCreditAccounts)
		.innerJoin(
			developerApps,
			eq(developerCreditAccounts.appId, developerApps.id),
		)
		.innerJoin(users, eq(developerCreditAccounts.ownerId, users.id))
		.where(
			and(
				eq(developerCreditAccounts.id, accountId),
				isNull(developerApps.deletedAt),
			),
		)
		.limit(1);

	if (!account) return { state: "skipped", reason: "not_found" };
	if (!account.autoTopUpEnabled)
		return { state: "skipped", reason: "disabled" };
	if (!canUseInfra(account.email)) {
		return { state: "skipped", reason: "not_allowed" };
	}
	if (!account.stripeCustomerId || !account.stripePaymentMethodId) {
		return { state: "skipped", reason: "no_card" };
	}
	const amountCents = account.autoTopUpAmountCents;
	if (
		autoTopUpSettingsError({
			enabled: true,
			thresholdMicroCredits: account.autoTopUpThresholdMicroCredits,
			amountCents,
			hasCard: true,
		})
	) {
		return { state: "skipped", reason: "invalid_settings" };
	}
	const available = (await availableBalance(account.appId)) ?? 0;
	if (available >= account.autoTopUpThresholdMicroCredits) {
		return { state: "skipped", reason: "above_threshold" };
	}

	const previous = await lastAttempt(accountId);
	if (
		previous &&
		now.getTime() - new Date(previous.createdAt).getTime() < ATTEMPT_INTERVAL_MS
	) {
		return { state: "skipped", reason: "recent_attempt" };
	}

	const period = utcDateKey(now);
	const productId = developerCreditsProductId();
	let paymentIntent: Stripe.PaymentIntent;
	try {
		paymentIntent = await stripe().paymentIntents.create(
			{
				amount: amountCents,
				currency: "usd",
				customer: account.stripeCustomerId,
				payment_method: account.stripePaymentMethodId,
				payment_method_types: ["card"],
				off_session: true,
				confirm: true,
				description: "Cap Infra credits, auto top-up",
				metadata: {
					type: AUTO_TOP_UP_METADATA_TYPE,
					accountId,
					appId: account.appId,
					amountCents: String(amountCents),
					period,
					...(productId ? { productId } : {}),
				},
			},
			{ idempotencyKey: autoTopUpIdempotencyKey(accountId, period) },
		);
	} catch (error) {
		const decline = declineFrom(error);
		if (!decline) {
			console.error("[infra-billing] Auto top-up could not be attempted", {
				accountId,
				error,
			});
			return { state: "error" };
		}
		await failAutoTopUp({ accountId, amountCents, period, ...decline });
		return { state: "failed", reason: decline.reason };
	}

	if (paymentIntent.status === "succeeded") {
		const balanceMicroCredits = await grantAutoTopUp({
			accountId,
			paymentIntentId: paymentIntent.id,
			amountCents: paymentIntent.amount_received,
			period,
		});
		return {
			state: "succeeded",
			paymentIntentId: paymentIntent.id,
			balanceMicroCredits,
		};
	}

	if (paymentIntent.status === "processing") {
		await recordPendingAutoTopUp({
			accountId,
			paymentIntentId: paymentIntent.id,
			amountCents,
			period,
		});
		return { state: "pending", paymentIntentId: paymentIntent.id };
	}

	await failAutoTopUp({
		accountId,
		paymentIntentId: paymentIntent.id,
		reason: paymentIntent.status,
		amountCents,
		period,
	});
	return { state: "failed", reason: paymentIntent.status };
}

export async function runDueAutoTopUps(now: Date = new Date()) {
	const due = await db()
		.select({ id: developerCreditAccounts.id })
		.from(developerCreditAccounts)
		.innerJoin(
			developerApps,
			eq(developerCreditAccounts.appId, developerApps.id),
		)
		.where(
			and(
				eq(developerCreditAccounts.autoTopUpEnabled, true),
				isNotNull(developerCreditAccounts.stripePaymentMethodId),
				isNull(developerApps.deletedAt),
			),
		);

	const summary = { attempted: 0, succeeded: 0, failed: 0 };
	for (const account of due) {
		try {
			const result = await runAutoTopUp(account.id, now);
			if (result.state === "skipped") continue;
			summary.attempted += 1;
			if (result.state === "succeeded") summary.succeeded += 1;
			if (result.state === "failed") summary.failed += 1;
		} catch (error) {
			console.error("[infra-billing] Auto top-up failed", {
				accountId: account.id,
				error,
			});
		}
	}
	return summary;
}

export async function settleAutoTopUpPaymentIntent(
	paymentIntent: Stripe.PaymentIntent,
	outcome: "succeeded" | "failed",
) {
	if (paymentIntent.metadata?.type !== AUTO_TOP_UP_METADATA_TYPE) return false;
	const { accountId, period } = paymentIntent.metadata;
	if (!accountId) return false;

	if (outcome === "succeeded") {
		if (
			paymentIntent.status !== "succeeded" ||
			paymentIntent.currency !== "usd" ||
			paymentIntent.amount_received <= 0
		) {
			return false;
		}
		await grantAutoTopUp({
			accountId,
			paymentIntentId: paymentIntent.id,
			amountCents: paymentIntent.amount_received,
			period: period ?? null,
		});
		return true;
	}

	await failAutoTopUp({
		accountId,
		paymentIntentId: paymentIntent.id,
		reason:
			paymentIntent.last_payment_error?.decline_code ??
			paymentIntent.last_payment_error?.code ??
			"card_declined",
		amountCents: paymentIntent.amount,
		period: period ?? utcDateKey(new Date()),
	});
	return true;
}

export async function saveCardFromCheckout(session: Stripe.Checkout.Session) {
	const accountId = session.metadata?.accountId;
	const setupIntentId =
		typeof session.setup_intent === "string"
			? session.setup_intent
			: session.setup_intent?.id;
	const customerId =
		typeof session.customer === "string"
			? session.customer
			: session.customer?.id;
	if (session.mode !== "setup" || !accountId || !setupIntentId || !customerId) {
		return false;
	}

	const setupIntent = await stripe().setupIntents.retrieve(setupIntentId, {
		expand: ["payment_method"],
	});
	const paymentMethod =
		typeof setupIntent.payment_method === "object"
			? setupIntent.payment_method
			: null;
	if (setupIntent.status !== "succeeded" || !paymentMethod) return false;

	const attachedTo =
		typeof paymentMethod.customer === "string"
			? paymentMethod.customer
			: paymentMethod.customer?.id;
	if (attachedTo !== customerId) return false;
	const paymentMethodId = paymentMethod.id;

	const [previous] = await db()
		.select({
			stripePaymentMethodId: developerCreditAccounts.stripePaymentMethodId,
		})
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.id, accountId))
		.limit(1);
	if (!previous) return false;
	if (previous.stripePaymentMethodId === paymentMethodId) return true;

	if (previous.stripePaymentMethodId) {
		const current = await stripe()
			.paymentMethods.retrieve(previous.stripePaymentMethodId)
			.catch(() => null);
		if (current && current.created > paymentMethod.created) return false;
	}

	await db()
		.update(developerCreditAccounts)
		.set({
			stripeCustomerId: customerId,
			stripePaymentMethodId: paymentMethodId,
		})
		.where(eq(developerCreditAccounts.id, accountId));

	if (
		previous.stripePaymentMethodId &&
		previous.stripePaymentMethodId !== paymentMethodId
	) {
		await stripe()
			.paymentMethods.detach(previous.stripePaymentMethodId)
			.catch((error) => {
				console.error("[infra-billing] Could not detach replaced card", error);
			});
	}
	return true;
}
