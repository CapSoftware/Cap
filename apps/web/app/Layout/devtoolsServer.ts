"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { eq } from "drizzle-orm";

export async function promoteToPro() {
	"use server";

	if (process.env.NODE_ENV !== "development")
		throw new Error("promoteToPro can only be used in development");

	const user = await getCurrentUser();
	if (!user) throw new Error("No current user session");
	await db()
		.update(users)
		.set({
			stripeCustomerId: "development",
			stripeSubscriptionId: "development",
			stripeSubscriptionStatus: "active",
		})
		.where(eq(users.id, user.id));
}

export async function demoteFromPro() {
	"use server";

	if (process.env.NODE_ENV !== "development")
		throw new Error("demoteFromPro can only be used in development");

	const user = await getCurrentUser();
	if (!user) throw new Error("No current user session");
	await db()
		.update(users)
		.set({
			stripeCustomerId: null,
			stripeSubscriptionId: null,
			stripeSubscriptionStatus: null,
		})
		.where(eq(users.id, user.id));
}
