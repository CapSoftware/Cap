"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { eq } from "drizzle-orm";

export async function patchAccountSettings(
	firstName?: string,
	lastName?: string,
	defaultOrgId?: string,
) {
	const currentUser = await getCurrentUser();
	if (!currentUser) throw new Error("Unauthorized");

	await db()
		.update(users)
		.set({
			name: firstName,
			lastName,
			defaultOrgId,
		})
		.where(eq(users.id, currentUser.id));
}
