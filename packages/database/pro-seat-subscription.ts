import type { User } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import type { db } from "./index.ts";
import { organizationMembers, organizations, users } from "./schema.ts";

type Transaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

// Call after a member's Pro seat row is gone. Seats don't record who sponsored
// them, so when only manager-sponsored seats remain the current pointer stays.
// The user row lock serializes releases for one user. Locking the remaining
// seat rows instead deadlocks two orgs turning off the same user's seats. Run
// this before the transaction's first plain read: under REPEATABLE READ that
// read pins the snapshot, and a release committed while this one waited on the
// user lock would stay invisible.
export async function releaseProSeatSubscription(
	tx: Transaction,
	userId: User.UserId,
) {
	await tx
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, userId))
		.for("update");
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
