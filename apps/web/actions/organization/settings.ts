"use server";

import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import { organizations } from "@inflight/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function updateOrganizationSettings(settings: {
	disableSummary?: boolean;
	disableCaptions?: boolean;
	disableChapters?: boolean;
	disableReactions?: boolean;
	disableTranscript?: boolean;
	disableComments?: boolean;
}) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	if (!settings) {
		throw new Error("Settings are required");
	}

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, user.activeOrganizationId));

	if (!organization) {
		throw new Error("Organization not found");
	}

	await db()
		.update(organizations)
		.set({ settings })
		.where(eq(organizations.id, user.activeOrganizationId));

	revalidatePath("/dashboard/caps");

	return { success: true };
}
