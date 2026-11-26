"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { eq, sql } from "drizzle-orm";
import { isDashboardPageSize } from "@/lib/dashboard-page-size";
import { userPreferencesObject } from "@/lib/user-preferences-sql";

export async function setDashboardPageSize(pageSize: unknown) {
	if (!isDashboardPageSize(pageSize)) throw new Error("Unsupported page size");
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	// JSON_SET will not create a missing parent object, so the `dashboard` key
	// is merged as a whole object onto the normalised preferences.
	await db()
		.update(users)
		.set({
			preferences: sql`JSON_MERGE_PATCH(${userPreferencesObject()}, CAST(${JSON.stringify(
				{ dashboard: { pageSize } },
			)} AS JSON))`,
		})
		.where(eq(users.id, user.id));

	return { pageSize };
}
