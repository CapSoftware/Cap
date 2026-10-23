import "server-only";

import { db } from "@cap/database";
import { organizations, users } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import type { Organisation, User } from "@cap/web-domain";
import { eq } from "drizzle-orm";

/** Whether a specific video's OWNER is on a Pro plan. */
export async function isVideoOwnerPro(ownerId: User.UserId): Promise<boolean> {
	const [owner] = await db()
		.select({
			stripeSubscriptionStatus: users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
		})
		.from(users)
		.where(eq(users.id, ownerId))
		.limit(1);

	return userIsPro(owner ?? null);
}

/**
 * Whether an organization's OWNER is on a Pro plan. Public collection links are
 * an org-wide Pro entitlement: any manager can publish while the owner is Pro.
 */
export async function isOrganizationOwnerPro(
	organizationId: Organisation.OrganisationId,
): Promise<boolean> {
	const [owner] = await db()
		.select({
			stripeSubscriptionStatus: users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
		})
		.from(organizations)
		.innerJoin(users, eq(organizations.ownerId, users.id))
		.where(eq(organizations.id, organizationId))
		.limit(1);

	return userIsPro(owner ?? null);
}
