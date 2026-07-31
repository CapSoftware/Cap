"use server";

import { PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE } from "@cap/analytics";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { sql } from "drizzle-orm";
import { cookies } from "next/headers";
import {
	identityLinkedEvent,
	userSignedUpEvent,
} from "@/lib/analytics/business-events";
import { queueServerProductEvent } from "@/lib/analytics/server";
import { normalizeServerIdentifier } from "@/lib/analytics/server-event";

const SIGNUP_TRACKING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type UserPreferences = {
	notifications?: {
		pauseComments: boolean;
		pauseReplies: boolean;
		pauseViews: boolean;
		pauseReactions: boolean;
	};
	trackedEvents?: {
		product_user_signed_up?: boolean;
		user_signed_up?: boolean;
	};
} | null;

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

const getCreatedAtTime = (value: unknown) => {
	if (value instanceof Date) {
		return value.getTime();
	}

	if (typeof value === "string" || typeof value === "number") {
		const parsed = new Date(value).getTime();
		return Number.isNaN(parsed) ? null : parsed;
	}

	return null;
};

export async function checkAndMarkUserSignedUpTracked(): Promise<{
	shouldTrack: boolean;
}> {
	const currentUser = await getCurrentUser();
	if (!currentUser) {
		return { shouldTrack: false };
	}

	try {
		const prefs = currentUser.preferences as UserPreferences;
		const alreadyTracked = Boolean(prefs?.trackedEvents?.user_signed_up);
		const productAlreadyTracked = Boolean(
			prefs?.trackedEvents?.product_user_signed_up,
		);

		const createdAtTime = getCreatedAtTime(currentUser.created_at);

		if (
			createdAtTime === null ||
			Date.now() - createdAtTime > SIGNUP_TRACKING_WINDOW_MS
		) {
			return { shouldTrack: false };
		}

		if (!productAlreadyTracked) {
			const analyticsAnonymousId = normalizeServerIdentifier(
				(await cookies()).get(PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE)?.value,
			);
			try {
				const createdAt = new Date(createdAtTime);
				await queueServerProductEvent(
					userSignedUpEvent({
						userId: currentUser.id,
						createdAt,
					}),
				);
				if (analyticsAnonymousId) {
					await queueServerProductEvent(
						identityLinkedEvent({
							userId: currentUser.id,
							organizationId: currentUser.activeOrganizationId,
							anonymousId: analyticsAnonymousId,
							createdAt,
						}),
					);
				}

				await db()
					.update(users)
					.set({
						preferences: sql`JSON_SET(COALESCE(${users.preferences}, JSON_OBJECT()), '$.trackedEvents.product_user_signed_up', true)`,
					})
					.where(
						sql`(${users.id} = ${currentUser.id}) AND JSON_CONTAINS(COALESCE(${users.preferences}, JSON_OBJECT()), CAST(true AS JSON), '$.trackedEvents.product_user_signed_up') = 0`,
					);
			} catch (error) {
				console.error("Failed to enqueue user_signed_up", error);
			}
		}

		if (alreadyTracked) {
			return { shouldTrack: false };
		}

		const result = await db()
			.update(users)
			.set({
				preferences: sql`JSON_SET(COALESCE(${users.preferences}, JSON_OBJECT()), '$.trackedEvents.user_signed_up', true)`,
			})
			.where(
				sql`(${users.id} = ${currentUser.id}) AND JSON_CONTAINS(COALESCE(${users.preferences}, JSON_OBJECT()), CAST(true AS JSON), '$.trackedEvents.user_signed_up') = 0`,
			);

		return { shouldTrack: getAffectedRows(result) > 0 };
	} catch {
		return { shouldTrack: false };
	}
}
