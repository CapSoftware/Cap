import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	developerApps,
	developerCreditAccounts,
	developerCreditTransactions,
	users,
} from "@cap/database/schema";
import { stripe } from "@cap/utils";
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	sql,
} from "drizzle-orm";
import { after } from "next/server";
import type Stripe from "stripe";
import { addCreditsToAccount } from "@/lib/developer-credits";
import { developerCreditsProductId } from "@/lib/developer-credits-product";
import { MICRO_CREDITS_PER_DOLLAR } from "@/lib/developer-pricing";
import { canUseInfra } from "@/lib/infra-access";
import { availableBalance } from "@/lib/infra-balance";
import { sendInfraTopUpFailedEmail } from "@/lib/infra-billing-emails";
import { disputedSince, type InfraDbExecutor } from "@/lib/infra-standing";
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

export const AUTO_TOP_UP_DAILY_LIMIT = 10;
export const AUTO_TOP_UP_STRIPE_TIMEOUT_MS = 20_000;
export const AUTO_TOP_UP_PENDING_RECONCILE_MS = 72 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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
				| "disputed"
				| "awaiting_payment"
				| "reconciled"
				| "recent_decline"
				| "daily_limit"
				| "in_progress";
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

export function autoTopUpIdempotencyKey(accountId: string, sequence: number) {
	return `infra-auto-top-up:${accountId}:${sequence}`;
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

function isUnresolvedAttempt(error: unknown) {
	if (typeof error !== "object" || error === null) return false;
	const fields = error as {
		type?: unknown;
		code?: unknown;
		statusCode?: unknown;
	};
	return (
		fields.code === "idempotency_key_in_use" ||
		fields.statusCode === 409 ||
		fields.type === "StripeIdempotencyError"
	);
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

async function attemptHistory(
	executor: InfraDbExecutor,
	accountId: string,
	now: Date,
) {
	const recent = await executor
		.select({
			type: developerCreditTransactions.type,
			referenceId: developerCreditTransactions.referenceId,
			createdAt: developerCreditTransactions.createdAt,
		})
		.from(developerCreditTransactions)
		.where(
			and(
				eq(developerCreditTransactions.accountId, accountId),
				inArray(
					developerCreditTransactions.referenceType,
					SETTLED_REFERENCE_TYPES,
				),
				gte(
					developerCreditTransactions.createdAt,
					new Date(now.getTime() - DAY_MS),
				),
			),
		);
	const [settled] = await executor
		.select({ settledAttempts: sql<number | string>`COUNT(*)` })
		.from(developerCreditTransactions)
		.where(
			and(
				eq(developerCreditTransactions.accountId, accountId),
				inArray(
					developerCreditTransactions.referenceType,
					SETTLED_REFERENCE_TYPES,
				),
			),
		);
	const pending = await executor
		.select({
			pendingId: developerCreditTransactions.referenceId,
			pendingSince: developerCreditTransactions.createdAt,
		})
		.from(developerCreditTransactions)
		.where(
			and(
				eq(developerCreditTransactions.accountId, accountId),
				eq(developerCreditTransactions.type, "topup_pending"),
				eq(
					developerCreditTransactions.referenceType,
					AUTO_TOP_UP_PENDING_REFERENCE_TYPE,
				),
			),
		);
	const pendingIds = pending.flatMap((row) =>
		row.pendingId ? [row.pendingId] : [],
	);
	const resolved = pendingIds.length
		? await executor
				.select({ settledId: developerCreditTransactions.referenceId })
				.from(developerCreditTransactions)
				.where(
					and(
						eq(developerCreditTransactions.accountId, accountId),
						inArray(
							developerCreditTransactions.referenceType,
							SETTLED_REFERENCE_TYPES,
						),
						inArray(developerCreditTransactions.referenceId, pendingIds),
					),
				)
		: [];
	const resolvedIds = new Set(resolved.map((row) => row.settledId));

	const latest = (type: string) =>
		Math.max(
			0,
			...recent
				.filter((row) => row.type === type)
				.map((row) => new Date(row.createdAt).getTime()),
		);
	const lastDecline = latest("topup_failed");
	return {
		sequence: Number(settled?.settledAttempts ?? 0),
		unresolved: pending.flatMap((row) =>
			row.pendingId && !resolvedIds.has(row.pendingId)
				? [
						{
							paymentIntentId: row.pendingId,
							since: new Date(row.pendingSince),
						},
					]
				: [],
		),
		declinedRecently: lastDecline > 0 && lastDecline >= latest("topup"),
		recentTopUps: recent.filter((row) => row.type === "topup").length,
	};
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

async function reconcilePendingAutoTopUp(
	accountId: string,
	paymentIntentId: string,
) {
	const paymentIntent = await stripe().paymentIntents.retrieve(
		paymentIntentId,
		{},
		{ timeout: AUTO_TOP_UP_STRIPE_TIMEOUT_MS },
	);
	if (paymentIntent.metadata?.accountId !== accountId) return;
	if (paymentIntent.status === "processing") {
		console.warn("[infra-billing] Auto top-up payment still processing", {
			accountId,
			paymentIntentId,
		});
		return;
	}
	await settleAutoTopUpPaymentIntent(
		paymentIntent,
		paymentIntent.status === "succeeded" ? "succeeded" : "failed",
	);
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
	const snapshot = await db().transaction(async (tx) => {
		const [locked] = await tx
			.select({ id: developerCreditAccounts.id })
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.id, accountId))
			.limit(1)
			.for("update");
		if (!locked) return null;
		return {
			available: (await availableBalance(account.appId, tx)) ?? 0,
			disputed: Boolean(await disputedSince(tx, accountId)),
			...(await attemptHistory(tx, accountId, now)),
		};
	});
	if (!snapshot) return { state: "skipped", reason: "not_found" };
	if (snapshot.available >= account.autoTopUpThresholdMicroCredits) {
		return { state: "skipped", reason: "above_threshold" };
	}
	if (snapshot.disputed) return { state: "skipped", reason: "disputed" };
	if (snapshot.unresolved.length > 0) {
		const stale = snapshot.unresolved.filter(
			(payment) =>
				now.getTime() - payment.since.getTime() >=
				AUTO_TOP_UP_PENDING_RECONCILE_MS,
		);
		if (stale.length === 0) {
			return { state: "skipped", reason: "awaiting_payment" };
		}
		for (const payment of stale) {
			await reconcilePendingAutoTopUp(accountId, payment.paymentIntentId);
		}
		return { state: "skipped", reason: "reconciled" };
	}
	if (snapshot.declinedRecently) {
		return { state: "skipped", reason: "recent_decline" };
	}
	if (snapshot.recentTopUps >= AUTO_TOP_UP_DAILY_LIMIT) {
		console.warn(
			"[infra-billing] Auto top-up waits: the daily limit of automatic top-ups is reached",
			{ accountId, limit: AUTO_TOP_UP_DAILY_LIMIT },
		);
		return { state: "skipped", reason: "daily_limit" };
	}

	const period = utcDateKey(now);
	const productId = developerCreditsProductId();
	const request = {
		amount: amountCents,
		currency: "usd",
		customer: account.stripeCustomerId,
		payment_method: account.stripePaymentMethodId,
		payment_method_types: ["card"],
		off_session: true,
		confirm: true,
		description: "Cap Infra credits, auto top-up",
		receipt_email: account.email,
		metadata: {
			type: AUTO_TOP_UP_METADATA_TYPE,
			accountId,
			appId: account.appId,
			amountCents: String(amountCents),
			sequence: String(snapshot.sequence),
			...(productId ? { productId } : {}),
		},
	} satisfies Stripe.PaymentIntentCreateParams;
	let paymentIntent: Stripe.PaymentIntent;
	try {
		paymentIntent = await stripe().paymentIntents.create(request, {
			idempotencyKey: autoTopUpIdempotencyKey(accountId, snapshot.sequence),
			timeout: AUTO_TOP_UP_STRIPE_TIMEOUT_MS,
		});
	} catch (error) {
		if (isUnresolvedAttempt(error)) {
			return { state: "skipped", reason: "in_progress" };
		}
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

async function creditAccountOf(target: AutoTopUpTarget) {
	if ("accountId" in target) return target.accountId;
	const [account] = await db()
		.select({ id: developerCreditAccounts.id })
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.appId, target.appId))
		.limit(1);
	return account?.id ?? null;
}

export type AutoTopUpTarget = { accountId: string } | { appId: string };

export async function scheduleAutoTopUp(
	target: AutoTopUpTarget,
): Promise<void> {
	const attempt = async () => {
		try {
			const accountId = await creditAccountOf(target);
			if (!accountId) return;
			const result = await runAutoTopUp(accountId);
			if (result.state !== "skipped") {
				console.log("[infra-billing] Auto top-up after a charge", {
					accountId,
					state: result.state,
				});
			}
		} catch (error) {
			console.error("[infra-billing] Auto top-up after a charge failed", {
				target,
				error,
			});
		}
	};
	try {
		after(attempt);
	} catch {
		await attempt();
	}
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
