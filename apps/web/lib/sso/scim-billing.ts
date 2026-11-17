import { db } from "@cap/database";
import { organizationSso, organizations, users } from "@cap/database/schema";
import {
	isScimPrice,
	isSsoSubscription,
	STRIPE_AVAILABLE,
	stripe,
} from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";

const ENTITLED_STATUSES = new Set(["active", "past_due"]);

export async function hasScimSubscription(
	organizationId: Organisation.OrganisationId,
) {
	if (!STRIPE_AVAILABLE()) return false;
	const [record] = await db()
		.select({
			ownerCustomerId: users.stripeCustomerId,
			ssoCustomerId: organizationSso.stripeCustomerId,
		})
		.from(organizations)
		.innerJoin(users, eq(users.id, organizations.ownerId))
		.leftJoin(
			organizationSso,
			eq(organizationSso.organizationId, organizations.id),
		)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	const customers = new Set(
		[record?.ownerCustomerId, record?.ssoCustomerId].filter(
			(customer): customer is string => Boolean(customer),
		),
	);
	for (const customer of customers) {
		for await (const subscription of stripe().subscriptions.list({
			customer,
			limit: 100,
		})) {
			if (
				ENTITLED_STATUSES.has(subscription.status) &&
				subscription.metadata?.organizationId === organizationId &&
				!isSsoSubscription(subscription) &&
				subscription.items.data.some((item) => isScimPrice(item.price.id))
			) {
				return true;
			}
		}
	}
	return false;
}
