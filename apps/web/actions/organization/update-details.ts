"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function updateOrganizationDetails({
	organizationName,
	allowedEmailDomain,
	organizationId,
}: {
	organizationName?: string | null;
	allowedEmailDomain?: string | null;
	organizationId: string;
}) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const organization = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId));

	if (!organization || organization.length === 0) {
		throw new Error("Organization not found");
	}

	if (organization[0]?.ownerId !== user.id) {
		throw new Error("Only the owner can update organization details");
	}

	if (organizationName) {
		await db()
			.update(organizations)
			.set({
				name: organizationName,
			})
			.where(eq(organizations.id, organizationId));
	}

	if (allowedEmailDomain || allowedEmailDomain === "") {
		await db()
			.update(organizations)
			.set({
				allowedEmailDomain: allowedEmailDomain,
			})
			.where(eq(organizations.id, organizationId));
	}

	revalidatePath("/dashboard/settings/organization");

	return { success: true };
}
