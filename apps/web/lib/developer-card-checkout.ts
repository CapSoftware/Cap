import { db } from "@cap/database";
import {
	developerApps,
	developerCreditAccounts,
	users,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { stripe } from "@cap/utils";
import type { User } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { ensureDeveloperStripeCustomer } from "@/lib/developer-stripe-customer";
import { canUseInfra } from "@/lib/infra-access";
import { infraAppPath } from "@/lib/infra-routes";

export type DeveloperCardCheckout =
	| { status: "ok"; url: string }
	| { status: "forbidden" | "not_found" | "failed" };

export async function createDeveloperCardCheckout({
	user,
	appId,
}: {
	user: { id: User.UserId; email: string };
	appId: string;
}): Promise<DeveloperCardCheckout> {
	if (!canUseInfra(user.email)) return { status: "forbidden" };

	const [account] = await db()
		.select({
			id: developerCreditAccounts.id,
			stripeCustomerId: developerCreditAccounts.stripeCustomerId,
			userStripeCustomerId: users.stripeCustomerId,
		})
		.from(developerCreditAccounts)
		.innerJoin(
			developerApps,
			eq(developerCreditAccounts.appId, developerApps.id),
		)
		.innerJoin(users, eq(developerApps.ownerId, users.id))
		.where(
			and(
				eq(developerApps.id, appId),
				eq(developerApps.ownerId, user.id),
				isNull(developerApps.deletedAt),
			),
		)
		.limit(1);

	if (!account) return { status: "not_found" };

	try {
		const customerId = await ensureDeveloperStripeCustomer({
			user: { ...user, stripeCustomerId: account.userStripeCustomerId },
			account,
		});
		const metadata = {
			type: "developer_card",
			appId,
			accountId: account.id,
			userId: user.id,
		};
		const session = await stripe().checkout.sessions.create({
			customer: customerId,
			mode: "setup",
			payment_method_types: ["card"],
			success_url: `${serverEnv().WEB_URL}${infraAppPath(appId, "billing")}?card=saved`,
			cancel_url: `${serverEnv().WEB_URL}${infraAppPath(appId, "billing")}`,
			metadata,
			setup_intent_data: { metadata },
		});
		return session.url
			? { status: "ok", url: session.url }
			: { status: "failed" };
	} catch (error) {
		console.error("Error creating developer card checkout:", error);
		return { status: "failed" };
	}
}
