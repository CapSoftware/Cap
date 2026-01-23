"use server";

import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import { users } from "@inflight/database/schema";
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
			onboardingSteps: null,
			name: null,
			lastName: null,
			onboarding_completed_at: null,
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
