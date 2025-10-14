"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { eq } from "drizzle-orm";

export async function promoteToPro() {
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

export async function restartOnboarding() {
	if (process.env.NODE_ENV !== "development")
		throw new Error("restartOnboarding can only be used in development");

	const user = await getCurrentUser();
	if (!user) throw new Error("No current user session");
	await db()
		.update(users)
		.set({
			onboardingSteps: {
				welcome: false,
				organizationSetup: false,
				customDomain: false,
				inviteTeam: false,
				download: false,
			},
		})
		.where(eq(users.id, user.id));
}

export async function demoteFromPro() {
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
