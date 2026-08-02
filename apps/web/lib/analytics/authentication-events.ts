import { randomUUID } from "node:crypto";
import { PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE } from "@cap/analytics";
import { db } from "@cap/database";
import { users } from "@cap/database/schema";
import { User } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { identityLinkedEvent, userSignedInEvent } from "./business-events";
import {
	persistProductAnalyticsEvent,
	queueDurableServerProductEvent,
} from "./product-event-outbox";
import { normalizeServerIdentifier } from "./server-event";

export async function recordWebAuthenticationSuccess(userId: string) {
	const normalizedUserId = normalizeServerIdentifier(userId);
	if (!normalizedUserId) {
		throw new Error("Authenticated user identity is invalid");
	}
	const typedUserId = User.UserId.make(normalizedUserId);
	const [user] = await db()
		.select({ organizationId: users.activeOrganizationId })
		.from(users)
		.where(eq(users.id, typedUserId))
		.limit(1);
	if (!user) throw new Error("Authenticated user does not exist");

	const anonymousId = normalizeServerIdentifier(
		(await cookies()).get(PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE)?.value,
	);
	const createdAt = new Date();
	const authenticationId = randomUUID();
	const events = [
		userSignedInEvent({
			authenticationId,
			userId: normalizedUserId,
			organizationId: user.organizationId,
			anonymousId,
			createdAt,
		}),
		...(anonymousId
			? [
					identityLinkedEvent({
						userId: normalizedUserId,
						organizationId: user.organizationId,
						anonymousId,
						createdAt,
						linkId: authenticationId,
					}),
				]
			: []),
	];

	await db().transaction(async (tx) => {
		for (const event of events) {
			await persistProductAnalyticsEvent(tx, event);
		}
	});
	await Promise.all(events.map(queueDurableServerProductEvent));
}
