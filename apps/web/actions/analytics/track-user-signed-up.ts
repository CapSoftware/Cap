"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { sql } from "drizzle-orm";

type UserPreferences = {
	notifications?: {
		pauseComments: boolean;
		pauseReplies: boolean;
		pauseViews: boolean;
		pauseReactions: boolean;
	};
	trackedEvents?: {
		user_signed_up?: boolean;
	};
} | null;

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

		if (alreadyTracked) {
			return { shouldTrack: false };
		}

		const result = await db()
			.update(users)
			.set({
				preferences: sql`JSON_SET(COALESCE(${users.preferences}, JSON_OBJECT()), '$.trackedEvents.user_signed_up', true)`,
			})
			.where(
				sql`(${users.id} = ${currentUser.id}) AND (${users.created_at} >= CURRENT_DATE()) AND JSON_CONTAINS(COALESCE(${users.preferences}, JSON_OBJECT()), CAST(true AS JSON), '$.trackedEvents.user_signed_up') = 0`,
			);

		if (result.rowsAffected && result.rowsAffected > 0) {
			return { shouldTrack: true };
		}

		return { shouldTrack: false };
	} catch {
		return { shouldTrack: false };
	}
}
