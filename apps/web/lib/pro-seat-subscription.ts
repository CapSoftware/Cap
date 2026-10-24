import type { db } from "@cap/database";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import type { User } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";

type Transaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

// Call after a member's Pro seat row is gone. Seats don't record who sponsored
// them, so when only manager-sponsored seats remain the current pointer stays.
export async function releaseProSeatSubscription(
	tx: Transaction,
	userId: User.UserId,
) {
	const remainingSeats = await tx
		.select({ stripeSubscriptionId: users.stripeSubscriptionId })
		.from(organizationMembers)
		.innerJoin(
			organizations,
			eq(organizationMembers.organizationId, organizations.id),
		)
		.innerJoin(users, eq(organizations.ownerId, users.id))
		.where(
			and(
				eq(organizationMembers.userId, userId),
				eq(organizationMembers.hasProSeat, true),
			),
		);
	const paidSeat = remainingSeats.find((seat) => seat.stripeSubscriptionId);
	if (!paidSeat && remainingSeats.length > 0) return;

	await tx
		.update(users)
		.set({
			thirdPartyStripeSubscriptionId: paidSeat?.stripeSubscriptionId ?? null,
		})
		.where(eq(users.id, userId));
}
