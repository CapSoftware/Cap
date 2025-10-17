"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function removeProfileImage() {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	await db()
		.update(users)
		.set({ image: null })
		.where(eq(users.id, user.id));

	revalidatePath("/dashboard/settings/account");
	revalidatePath("/dashboard", "layout");

	return { success: true } as const;
}
