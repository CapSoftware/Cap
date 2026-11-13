import { db } from "@cap/database";
import {
	developerCreditAccounts,
	developerCreditTransactions,
} from "@cap/database/schema";
import type { User } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { CREDIT_CHECKOUT_3DS_OVER_CENTS } from "@/lib/infra-credit-checkout";

type Reader = Pick<ReturnType<typeof db>, "select">;

export async function ownerHasPaidCreditPurchase(
	ownerId: User.UserId,
	database: Reader = db(),
) {
	const [purchase] = await database
		.select({ id: developerCreditTransactions.id })
		.from(developerCreditAccounts)
		.innerJoin(
			developerCreditTransactions,
			eq(developerCreditTransactions.accountId, developerCreditAccounts.id),
		)
		.where(
			and(
				eq(developerCreditAccounts.ownerId, ownerId),
				eq(developerCreditTransactions.type, "topup"),
				eq(developerCreditTransactions.referenceType, "stripe_payment_intent"),
			),
		)
		.limit(1);
	return Boolean(purchase);
}

export async function isFirstLargeCreditPurchase(
	ownerId: User.UserId,
	amountCents: number,
	database: Reader = db(),
) {
	if (amountCents <= CREDIT_CHECKOUT_3DS_OVER_CENTS) return false;
	return !(await ownerHasPaidCreditPurchase(ownerId, database));
}
