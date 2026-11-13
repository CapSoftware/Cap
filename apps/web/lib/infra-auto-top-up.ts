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
	asc,
	desc,
	eq,
	getTableName,
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
import { availableBalance, heldTranscriptsByApp } from "@/lib/infra-balance";
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
const DUE_PAGE_SIZE = 200;

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

export type AutoTopUpAttempt = { topUps: number; declines: number };

export function autoTopUpIdempotencyKey(
	accountId: string,
	{ topUps, declines }: AutoTopUpAttempt,
) {
	return `infra-auto-top-up:${accountId}:${topUps}:${declines}`;
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

const ATTEMPT_LEDGER_TYPES = {
	[AUTO_TOP_UP_REFERENCE_TYPE]: "topup",
	[AUTO_TOP_UP_FAILED_REFERENCE_TYPE]: "topup_failed",
	[AUTO_TOP_UP_PENDING_REFERENCE_TYPE]: "topup_pending",
} as const;

const NEVER_ATTEMPTED = "1970-01-01 00:00:00";

const sqlTime = (date: Date) =>
	date.toISOString().slice(0, 23).replace("T", " ");

function ledgerAlias(name: string) {
	const column = (field: { name: string }) =>
		sql`${sql.identifier(name)}.${sql.identifier(field.name)}`;
	return {
		from: sql`${sql.identifier(getTableName(developerCreditTransactions))} ${sql.identifier(name)}`,
		accountId: column(developerCreditTransactions.accountId),
		type: column(developerCreditTransactions.type),
		referenceId: column(developerCreditTransactions.referenceId),
		referenceType: column(developerCreditTransactions.referenceType),
		createdAt: column(developerCreditTransactions.createdAt),
	};
}

const inList = (values: readonly string[]) =>
	sql.join(
		values.map((value) => sql`${value}`),
		sql`, `,
	);

export function autoTopUpWaits(now: Date) {
	const accountRow = sql`${sql.identifier(getTableName(developerCreditAccounts))}.${sql.identifier(developerCreditAccounts.id.name)}`;
	const pendingAttempt = ledgerAlias("pending_attempt");
	const settledAttempt = ledgerAlias("settled_attempt");
	const declinedAttempt = ledgerAlias("declined_attempt");
	const laterTopUp = ledgerAlias("later_top_up");
	const recentTopUp = ledgerAlias("recent_top_up");
	const dayAgo = sqlTime(new Date(now.getTime() - DAY_MS));
	const reconcileFrom = sqlTime(
		new Date(now.getTime() - AUTO_TOP_UP_PENDING_RECONCILE_MS),
	);
	return {
		pending: sql<number>`exists (select 1 from ${pendingAttempt.from} where ${pendingAttempt.accountId} = ${accountRow} and ${pendingAttempt.type} = ${ATTEMPT_LEDGER_TYPES[AUTO_TOP_UP_PENDING_REFERENCE_TYPE]} and ${pendingAttempt.referenceType} = ${AUTO_TOP_UP_PENDING_REFERENCE_TYPE} and ${pendingAttempt.createdAt} > ${reconcileFrom} and not exists (select 1 from ${settledAttempt.from} where ${settledAttempt.accountId} = ${pendingAttempt.accountId} and ${settledAttempt.referenceId} = ${pendingAttempt.referenceId} and ${settledAttempt.referenceType} in (${inList(SETTLED_REFERENCE_TYPES)})))`,
		decline: sql<number>`exists (select 1 from ${declinedAttempt.from} where ${declinedAttempt.accountId} = ${accountRow} and ${declinedAttempt.type} = ${ATTEMPT_LEDGER_TYPES[AUTO_TOP_UP_FAILED_REFERENCE_TYPE]} and ${declinedAttempt.referenceType} = ${AUTO_TOP_UP_FAILED_REFERENCE_TYPE} and ${declinedAttempt.createdAt} > ${dayAgo} and not exists (select 1 from ${laterTopUp.from} where ${laterTopUp.accountId} = ${declinedAttempt.accountId} and ${laterTopUp.type} = ${ATTEMPT_LEDGER_TYPES[AUTO_TOP_UP_REFERENCE_TYPE]} and ${laterTopUp.referenceType} = ${AUTO_TOP_UP_REFERENCE_TYPE} and ${laterTopUp.createdAt} > ${declinedAttempt.createdAt}))`,
		limit: sql<number>`(select count(*) from ${recentTopUp.from} where ${recentTopUp.accountId} = ${accountRow} and ${recentTopUp.type} = ${ATTEMPT_LEDGER_TYPES[AUTO_TOP_UP_REFERENCE_TYPE]} and ${recentTopUp.referenceType} = ${AUTO_TOP_UP_REFERENCE_TYPE} and ${recentTopUp.createdAt} > ${dayAgo}) >= ${AUTO_TOP_UP_DAILY_LIMIT}`,
	};
}

export function autoTopUpReleased(now: Date) {
	const waits = autoTopUpWaits(now);
	return sql`not (${waits.pending} or ${waits.decline} or ${waits.limit})`;
}

export function autoTopUpLastAttemptAt() {
	return sql`(select max(${developerCreditTransactions.createdAt}) from ${developerCreditTransactions} where ${developerCreditTransactions.accountId} = ${developerCreditAccounts.id} and ${inArray(
		developerCreditTransactions.type,
		ATTEMPT_REFERENCE_TYPES.map((type) => ATTEMPT_LEDGER_TYPES[type]),
	)} and ${inArray(
		developerCreditTransactions.referenceType,
		ATTEMPT_REFERENCE_TYPES,
	)})`;
}

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
				inArray(
					developerCreditTransactions.type,
					referenceTypes.map((type) => ATTEMPT_LEDGER_TYPES[type]),
				),
				inArray(developerCreditTransactions.referenceType, referenceTypes),
			),
		)
		.orderBy(desc(developerCreditTransactions.createdAt))
		.limit(1);
	return row ?? null;
}

async function attemptHistory(executor: InfraDbExecutor, accountId: string) {
	const [settled] = await executor
		.select({
			topUps: sql<
				number | string | null
			>`SUM(${developerCreditTransactions.referenceType} = ${AUTO_TOP_UP_REFERENCE_TYPE})`,
			declines: sql<
				number | string | null
			>`SUM(${developerCreditTransactions.referenceType} = ${AUTO_TOP_UP_FAILED_REFERENCE_TYPE})`,
		})
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
		.select({ pendingId: developerCreditTransactions.referenceId })
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
	return {
		attempt: {
			topUps: Number(settled?.topUps ?? 0),
			declines: Number(settled?.declines ?? 0),
		},
		unresolved: pendingIds.filter((id) => !resolvedIds.has(id)),
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
		const waits = autoTopUpWaits(now);
		const [locked] = await tx
			.select({
				id: developerCreditAccounts.id,
				pendingWait: waits.pending,
				declineWait: waits.decline,
				limitWait: waits.limit,
			})
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.id, accountId))
			.limit(1)
			.for("update");
		if (!locked) return null;
		return {
			available: (await availableBalance(account.appId, tx)) ?? 0,
			disputed: Boolean(await disputedSince(tx, accountId)),
			waits: {
				pending: Boolean(Number(locked.pendingWait)),
				decline: Boolean(Number(locked.declineWait)),
				limit: Boolean(Number(locked.limitWait)),
			},
			...(await attemptHistory(tx, accountId)),
		};
	});
	if (!snapshot) return { state: "skipped", reason: "not_found" };
	if (snapshot.available >= account.autoTopUpThresholdMicroCredits) {
		return { state: "skipped", reason: "above_threshold" };
	}
	if (snapshot.disputed) return { state: "skipped", reason: "disputed" };
	if (snapshot.waits.pending) {
		return { state: "skipped", reason: "awaiting_payment" };
	}
	if (snapshot.waits.decline) {
		return { state: "skipped", reason: "recent_decline" };
	}
	if (snapshot.waits.limit) {
		console.warn(
			"[infra-billing] Auto top-up waits: the daily limit of automatic top-ups is reached",
			{ accountId, limit: AUTO_TOP_UP_DAILY_LIMIT },
		);
		return { state: "skipped", reason: "daily_limit" };
	}
	if (snapshot.unresolved.length > 0) {
		for (const payment of snapshot.unresolved) {
			await reconcilePendingAutoTopUp(accountId, payment);
		}
		return { state: "skipped", reason: "reconciled" };
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
			attempt: `${snapshot.attempt.topUps}:${snapshot.attempt.declines}`,
			...(productId ? { productId } : {}),
		},
	} satisfies Stripe.PaymentIntentCreateParams;
	let paymentIntent: Stripe.PaymentIntent;
	try {
		paymentIntent = await stripe().paymentIntents.create(request, {
			idempotencyKey: autoTopUpIdempotencyKey(accountId, snapshot.attempt),
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

type DueCursor = { attemptKey: string; id: string };

function dueAutoTopUpsAfter(now: Date, cursor: DueCursor | null) {
	const attemptKey = sql`cast(coalesce(${autoTopUpLastAttemptAt()}, ${NEVER_ATTEMPTED}) as char)`;
	const held = heldTranscriptsByApp(db());
	return db()
		.select({
			id: developerCreditAccounts.id,
			attemptKey: sql<string>`${attemptKey}`.as("attemptKey"),
		})
		.from(developerCreditAccounts)
		.innerJoin(
			developerApps,
			eq(developerCreditAccounts.appId, developerApps.id),
		)
		.leftJoin(held, eq(held.appId, developerCreditAccounts.appId))
		.where(
			and(
				eq(developerCreditAccounts.autoTopUpEnabled, true),
				isNotNull(developerCreditAccounts.stripePaymentMethodId),
				isNull(developerApps.deletedAt),
				sql`${developerCreditAccounts.balanceMicroCredits} < ${developerCreditAccounts.autoTopUpThresholdMicroCredits} + coalesce(${held.heldMicroCredits}, 0)`,
				autoTopUpReleased(now),
				cursor
					? sql`(${attemptKey} > ${cursor.attemptKey} or (${attemptKey} = ${cursor.attemptKey} and ${developerCreditAccounts.id} > ${cursor.id}))`
					: undefined,
			),
		)
		.orderBy(sql`attemptKey`, asc(developerCreditAccounts.id))
		.limit(DUE_PAGE_SIZE);
}

export async function runDueAutoTopUps(
	now: Date = new Date(),
	{ until = Number.POSITIVE_INFINITY }: { until?: number } = {},
) {
	const summary = { attempted: 0, succeeded: 0, failed: 0 };
	let cursor: DueCursor | null = null;
	for (;;) {
		const due: DueCursor[] = await dueAutoTopUpsAfter(now, cursor);
		for (const account of due) {
			if (Date.now() >= until) return summary;
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
		const last = due.at(-1);
		if (!last || due.length < DUE_PAGE_SIZE) return summary;
		cursor = last;
	}
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
