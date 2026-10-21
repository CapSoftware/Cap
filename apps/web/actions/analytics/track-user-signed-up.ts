"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { affectedRows as getAffectedRows } from "@cap/database/helpers";
import { jsonbGet, jsonbObject, jsonbText } from "@cap/database/json";
import { users } from "@cap/database/schema";
import { sql } from "drizzle-orm";

const SIGNUP_TRACKING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

		if (alreadyTracked) {
			return { shouldTrack: false };
		}

		const createdAtTime = getCreatedAtTime(currentUser.created_at);

		if (
			createdAtTime === null ||
			Date.now() - createdAtTime > SIGNUP_TRACKING_WINDOW_MS
		) {
			return { shouldTrack: false };
		}

		const result = await db()
			.update(users)
			.set({
				preferences: sql`jsonb_set(${jsonbObject(users.preferences)}, '{trackedEvents}', COALESCE(${jsonbGet(users.preferences, ["trackedEvents"])}, '{}'::jsonb) || '{"user_signed_up": true}'::jsonb)`,
			})
			.where(
				sql`(${users.id} = ${currentUser.id}) AND COALESCE(${jsonbText(users.preferences, ["trackedEvents", "user_signed_up"])}, 'false') <> 'true'`,
			);

		return { shouldTrack: getAffectedRows(result) > 0 };
	} catch {
		return { shouldTrack: false };
	}
}
