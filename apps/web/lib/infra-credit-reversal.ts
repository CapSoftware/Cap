import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	type DeveloperCreditReferenceType,
	developerCreditAccounts,
	developerCreditTransactions,
} from "@cap/database/schema";
import { stripe } from "@cap/utils";
import { and, eq, inArray, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { AUTO_TOP_UP_METADATA_TYPE } from "@/lib/infra-auto-top-up";
import { STRIPE_DISPUTE_REFERENCE_TYPE } from "@/lib/infra-standing";

export const STRIPE_REFUND_REFERENCE_TYPE = "stripe_refund" as const;

const PAID_GRANT_REFERENCE_TYPES = [
	"stripe_payment_intent",
	"auto_top_up",
] as const satisfies readonly DeveloperCreditReferenceType[];

const REVERSAL_REFERENCE_TYPES = [
	STRIPE_REFUND_REFERENCE_TYPE,
	STRIPE_DISPUTE_REFERENCE_TYPE,
] as const satisfies readonly DeveloperCreditReferenceType[];

const REFUNDS_THAT_MOVED_NO_MONEY = new Set(["failed", "canceled"]);

const CREDIT_CHECKOUT_METADATA_TYPE = "developer_credits";

export type CreditReversalResult =
	| { state: "ignored"; reason: "no_payment" | "not_a_credit_payment" }
	| { state: "grant_pending" }
	| { state: "duplicate" }
	| { state: "nothing_left" }
	| {
			state: "reversed";
			deductedMicroCredits: number;
			uncollectedMicroCredits: number;
			balanceMicroCredits: number;
	  };

type PaidGrant = { accountId: string; amountMicroCredits: number };

type Reversal =
	| { kind: "refund"; id: string; cents: number; chargeCents: number }
	| { kind: "dispute"; id: string; cents: number; reason: string | null };

const idOf = (value: string | { id: string } | null | undefined) =>
	typeof value === "string" ? value : (value?.id ?? null);

function metadataFields(value: unknown): Record<string, unknown> {
	let metadata: unknown = value;
	if (typeof metadata === "string") {
		try {
			metadata = JSON.parse(metadata);
		} catch {
			metadata = null;
		}
	}
	return typeof metadata === "object" && metadata !== null
		? (metadata as Record<string, unknown>)
		: {};
}

const wholeNumber = (value: unknown) => {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};

type PaymentHints = {
	invoice?: string | { id: string } | null;
	metadata?: Stripe.Metadata | null;
};

const autoTopUpAccount = (metadata: Stripe.Metadata | null | undefined) =>
	metadata?.type === AUTO_TOP_UP_METADATA_TYPE
		? (metadata.accountId ?? null)
		: undefined;

async function creditAccountOfPayment(
	paymentIntentId: string,
	hints: PaymentHints = {},
) {
	if (hints.invoice) return null;
	const hinted = autoTopUpAccount(hints.metadata);
	if (hinted !== undefined) return hinted;

	const paymentIntent = await stripe().paymentIntents.retrieve(paymentIntentId);
	if (paymentIntent.invoice) return null;
	const topUp = autoTopUpAccount(paymentIntent.metadata);
	if (topUp !== undefined) return topUp;

	const sessions = await stripe().checkout.sessions.list({
		payment_intent: paymentIntentId,
		limit: 1,
	});
	const metadata = sessions.data[0]?.metadata;
	return metadata?.type === CREDIT_CHECKOUT_METADATA_TYPE
		? (metadata.accountId ?? null)
		: null;
}

type PaidGrantLookup =
	| { state: "not_a_credit_payment" }
	| { state: "grant_pending"; accountId: string }
	| { state: "found"; grant: PaidGrant };

async function findPaidGrant(
	paymentIntentId: string,
	hints?: PaymentHints,
): Promise<PaidGrantLookup> {
	const accountId = await creditAccountOfPayment(paymentIntentId, hints);
	if (!accountId) return { state: "not_a_credit_payment" };

	const [grant] = await db()
		.select({
			accountId: developerCreditTransactions.accountId,
			amountMicroCredits: developerCreditTransactions.amountMicroCredits,
		})
		.from(developerCreditTransactions)
		.where(
			and(
				eq(developerCreditTransactions.accountId, accountId),
				eq(developerCreditTransactions.referenceId, paymentIntentId),
				inArray(developerCreditTransactions.referenceType, [
					...PAID_GRANT_REFERENCE_TYPES,
				]),
				eq(developerCreditTransactions.type, "topup"),
			),
		)
		.limit(1);
	if (grant) {
		return grant.amountMicroCredits > 0
			? { state: "found", grant }
			: { state: "not_a_credit_payment" };
	}

	const [account] = await db()
		.select({ id: developerCreditAccounts.id })
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.id, accountId))
		.limit(1);
	return account
		? { state: "grant_pending", accountId }
		: { state: "not_a_credit_payment" };
}

function grantPending(
	event: "refund" | "dispute",
	accountId: string,
	paymentIntentId: string,
): CreditReversalResult {
	console.warn(
		`[infra-billing] A ${event} arrived before its credit grant was recorded, leaving it for redelivery`,
		{ accountId, paymentIntentId },
	);
	return { state: "grant_pending" };
}

export const awaitsCreditGrant = (
	results: CreditReversalResult | CreditReversalResult[],
) => [results].flat().some((result) => result.state === "grant_pending");

export function refundedShareMicroCredits({
	grantMicroCredits,
	refundedCents,
	chargeCents,
}: {
	grantMicroCredits: number;
	refundedCents: number;
	chargeCents: number;
}) {
	if (chargeCents <= 0 || refundedCents >= chargeCents)
		return grantMicroCredits;
	return Math.floor(
		(grantMicroCredits * Math.max(0, refundedCents)) / chargeCents,
	);
}

async function applyReversal({
	grant,
	paymentIntentId,
	chargeId,
	reversal,
}: {
	grant: PaidGrant;
	paymentIntentId: string;
	chargeId: string | null;
	reversal: Reversal;
}): Promise<CreditReversalResult> {
	const referenceType =
		reversal.kind === "refund"
			? STRIPE_REFUND_REFERENCE_TYPE
			: STRIPE_DISPUTE_REFERENCE_TYPE;

	return db().transaction(async (tx) => {
		const [account] = await tx
			.select({
				balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
				autoTopUpEnabled: developerCreditAccounts.autoTopUpEnabled,
			})
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.id, grant.accountId))
			.limit(1)
			.for("update");
		if (!account) {
			return { state: "ignored", reason: "not_a_credit_payment" };
		}

		const earlier = (
			await tx
				.select({
					referenceId: developerCreditTransactions.referenceId,
					referenceType: developerCreditTransactions.referenceType,
					metadata: developerCreditTransactions.metadata,
				})
				.from(developerCreditTransactions)
				.where(
					and(
						eq(developerCreditTransactions.accountId, grant.accountId),
						inArray(developerCreditTransactions.type, ["refund", "adjustment"]),
						inArray(developerCreditTransactions.referenceType, [
							...REVERSAL_REFERENCE_TYPES,
						]),
					),
				)
		)
			.map((row) => ({ ...row, fields: metadataFields(row.metadata) }))
			.filter((row) => row.fields.paymentIntentId === paymentIntentId);

		if (
			earlier.some(
				(row) =>
					row.referenceType === referenceType &&
					row.referenceId === reversal.id,
			)
		) {
			return { state: "duplicate" };
		}

		const requestedBefore = (rows: typeof earlier) =>
			rows.reduce(
				(total, row) => total + wholeNumber(row.fields.requestedMicroCredits),
				0,
			);
		const remaining = Math.max(
			0,
			grant.amountMicroCredits - requestedBefore(earlier),
		);

		let requested = remaining;
		if (reversal.kind === "refund") {
			const refunds = earlier.filter(
				(row) => row.referenceType === STRIPE_REFUND_REFERENCE_TYPE,
			);
			const refundedCents =
				refunds.reduce(
					(total, row) => total + wholeNumber(row.fields.refundCents),
					0,
				) + reversal.cents;
			const share = refundedShareMicroCredits({
				grantMicroCredits: grant.amountMicroCredits,
				refundedCents,
				chargeCents: reversal.chargeCents,
			});
			requested = Math.min(
				remaining,
				Math.max(0, share - requestedBefore(refunds)),
			);
			if (requested === 0) return { state: "nothing_left" };
		}

		const deducted = Math.min(requested, account.balanceMicroCredits);
		const uncollected = requested - deducted;
		const balanceAfter = account.balanceMicroCredits - deducted;
		const switchesAutoTopUpOff =
			reversal.kind === "dispute" && account.autoTopUpEnabled;

		if (deducted > 0 || switchesAutoTopUpOff) {
			await tx
				.update(developerCreditAccounts)
				.set({
					...(deducted > 0
						? {
								balanceMicroCredits: sql`${developerCreditAccounts.balanceMicroCredits} - ${deducted}`,
							}
						: {}),
					...(switchesAutoTopUpOff ? { autoTopUpEnabled: false } : {}),
				})
				.where(eq(developerCreditAccounts.id, grant.accountId));
		}

		await tx.insert(developerCreditTransactions).values({
			id: nanoId(),
			accountId: grant.accountId,
			type: reversal.kind === "refund" ? "refund" : "adjustment",
			amountMicroCredits: deducted > 0 ? -deducted : 0,
			balanceAfterMicroCredits: balanceAfter,
			referenceId: reversal.id,
			referenceType,
			metadata: {
				paymentIntentId,
				chargeId,
				requestedMicroCredits: requested,
				uncollectedMicroCredits: uncollected,
				...(reversal.kind === "refund"
					? { refundCents: reversal.cents, chargeCents: reversal.chargeCents }
					: {
							disputeCents: reversal.cents,
							reason: reversal.reason,
							autoTopUpSwitchedOff: switchesAutoTopUpOff,
						}),
			},
		});

		return {
			state: "reversed",
			deductedMicroCredits: deducted,
			uncollectedMicroCredits: uncollected,
			balanceMicroCredits: balanceAfter,
		};
	});
}

const REFUND_PAGE_SIZE = 100;
const MAX_REFUNDS_PER_CHARGE = 5_000;

async function listRefunds(chargeId: string) {
	const refunds: Stripe.Refund[] = [];
	let startingAfter: string | undefined;
	for (;;) {
		const page = await stripe().refunds.list({
			charge: chargeId,
			limit: REFUND_PAGE_SIZE,
			...(startingAfter ? { starting_after: startingAfter } : {}),
		});
		refunds.push(...page.data);
		const last = page.data.at(-1);
		if (!page.has_more || !last) return refunds;
		if (refunds.length >= MAX_REFUNDS_PER_CHARGE) {
			throw new Error(
				`Charge ${chargeId} has more than ${MAX_REFUNDS_PER_CHARGE} refunds`,
			);
		}
		startingAfter = last.id;
	}
}

async function refundsOf(charge: Stripe.Charge) {
	const embedded = charge.refunds;
	const refunds =
		embedded && Array.isArray(embedded.data) && !embedded.has_more
			? embedded.data
			: await listRefunds(charge.id);
	return refunds
		.filter(
			(refund) =>
				refund.amount > 0 &&
				!REFUNDS_THAT_MOVED_NO_MONEY.has(refund.status ?? ""),
		)
		.sort((a, b) => a.created - b.created);
}

export async function reverseRefundedCharge(
	charge: Stripe.Charge,
): Promise<CreditReversalResult[]> {
	const paymentIntentId = idOf(charge.payment_intent);
	if (!paymentIntentId) return [{ state: "ignored", reason: "no_payment" }];
	const lookup = await findPaidGrant(paymentIntentId, {
		invoice: charge.invoice,
		metadata: charge.metadata,
	});
	if (lookup.state === "grant_pending") {
		return [grantPending("refund", lookup.accountId, paymentIntentId)];
	}
	if (lookup.state !== "found") {
		return [{ state: "ignored", reason: "not_a_credit_payment" }];
	}
	const { grant } = lookup;

	const results: CreditReversalResult[] = [];
	for (const refund of await refundsOf(charge)) {
		const result = await applyReversal({
			grant,
			paymentIntentId,
			chargeId: charge.id,
			reversal: {
				kind: "refund",
				id: refund.id,
				cents: refund.amount,
				chargeCents: charge.amount,
			},
		});
		if (result.state === "reversed") {
			console.log("[infra-billing] Credit taken back for a refund", {
				accountId: grant.accountId,
				refundId: refund.id,
				deductedMicroCredits: result.deductedMicroCredits,
				uncollectedMicroCredits: result.uncollectedMicroCredits,
			});
		}
		results.push(result);
	}
	return results;
}

export async function reverseDisputedPayment(
	dispute: Stripe.Dispute,
): Promise<CreditReversalResult> {
	const paymentIntentId = idOf(dispute.payment_intent);
	if (!paymentIntentId) return { state: "ignored", reason: "no_payment" };
	const lookup = await findPaidGrant(paymentIntentId);
	if (lookup.state === "grant_pending") {
		return grantPending("dispute", lookup.accountId, paymentIntentId);
	}
	if (lookup.state !== "found") {
		return { state: "ignored", reason: "not_a_credit_payment" };
	}
	const { grant } = lookup;

	const result = await applyReversal({
		grant,
		paymentIntentId,
		chargeId: idOf(dispute.charge),
		reversal: {
			kind: "dispute",
			id: dispute.id,
			cents: dispute.amount,
			reason: dispute.reason ?? null,
		},
	});
	if (result.state === "reversed") {
		console.log("[infra-billing] Credit taken back for a dispute", {
			accountId: grant.accountId,
			disputeId: dispute.id,
			deductedMicroCredits: result.deductedMicroCredits,
			uncollectedMicroCredits: result.uncollectedMicroCredits,
		});
	}
	return result;
}
