import {
	PRODUCT_ANALYTICS_ACCOUNT_DELETION_PENDING_SUBJECT,
	ProductAnalyticsError,
	sendProductAnalyticsRows,
} from "@cap/analytics";
import { db } from "@cap/database";
import {
	messengerSupportEmails,
	organizations,
	users,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Organisation, User } from "@cap/web-domain";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { FatalError } from "workflow";
import { start } from "workflow/api";
import {
	createServerProductEventRows,
	type ServerProductEvent,
} from "@/lib/analytics/server-event";

async function isProductAnalyticsIdentitySuppressed(event: ServerProductEvent) {
	const pendingDeletionUserIds = db()
		.select({ userId: messengerSupportEmails.userId })
		.from(messengerSupportEmails)
		.where(
			eq(
				messengerSupportEmails.subject,
				PRODUCT_ANALYTICS_ACCOUNT_DELETION_PENDING_SUBJECT,
			),
		);
	const [userRows, organizationRows] = await Promise.all([
		event.userId
			? db()
					.select({ id: users.id })
					.from(users)
					.where(
						and(
							eq(users.id, User.UserId.make(event.userId)),
							notInArray(users.id, pendingDeletionUserIds),
						),
					)
					.limit(1)
			: Promise.resolve([{}]),
		event.organizationId
			? db()
					.select({ id: organizations.id })
					.from(organizations)
					.where(
						and(
							eq(
								organizations.id,
								Organisation.OrganisationId.make(event.organizationId),
							),
							isNull(organizations.tombstoneAt),
						),
					)
					.limit(1)
			: Promise.resolve([{}]),
	]);
	return userRows.length === 0 || organizationRows.length === 0;
}

export async function deliverProductAnalyticsEventStep(
	event: ServerProductEvent,
) {
	"use step";
	if (await isProductAnalyticsIdentitySuppressed(event)) {
		return { eventId: event.eventId, suppressed: true as const };
	}

	const rows = createServerProductEventRows(event);
	if (rows.length !== 1) {
		throw new FatalError("Product analytics event failed contract validation");
	}
	const env = serverEnv();
	const host = env.PRODUCT_ANALYTICS_TINYBIRD_HOST;
	const token = env.PRODUCT_ANALYTICS_TINYBIRD_TOKEN;
	if (!host || !token) {
		throw new FatalError("Product analytics delivery is not configured");
	}

	try {
		await sendProductAnalyticsRows({
			host,
			token,
			rows,
			wait: true,
			maxAttempts: 1,
		});
	} catch (error) {
		if (error instanceof ProductAnalyticsError && !error.retryable) {
			throw new FatalError(
				`Product analytics permanently rejected event with status ${error.status ?? "unknown"}`,
			);
		}
		throw new Error("Product analytics delivery temporarily failed");
	}

	return { eventId: event.eventId };
}
deliverProductAnalyticsEventStep.maxRetries = 8;

export async function enqueueProductAnalyticsEventStep(
	event: ServerProductEvent,
) {
	"use step";

	const run = await start(deliverProductAnalyticsEventWorkflow, [event]);
	return { eventId: event.eventId, runId: run.runId };
}
enqueueProductAnalyticsEventStep.maxRetries = 8;

export const enqueueReconciledProductAnalyticsEventStep =
	enqueueProductAnalyticsEventStep;

export async function deliverProductAnalyticsEventWorkflow(
	event: ServerProductEvent,
) {
	"use workflow";

	return deliverProductAnalyticsEventStep(event);
}
