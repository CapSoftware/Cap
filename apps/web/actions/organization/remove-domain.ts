"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function removeOrganizationDomain(organizationId: string) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId));

	if (!organization || organization.ownerId !== user.id) {
		throw new Error("Only the owner can remove the custom domain");
	}

	try {
		if (organization.customDomain) {
			await fetch(
				`https://api.vercel.com/v9/projects/${
					process.env.VERCEL_PROJECT_ID
				}/domains/${organization.customDomain.toLowerCase()}?teamId=${
					process.env.VERCEL_TEAM_ID
				}`,
				{
					method: "DELETE",
					headers: {
						Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
					},
				},
			);
		}

		await db()
			.update(organizations)
			.set({
				customDomain: null,
				domainVerified: null,
			})
			.where(eq(organizations.id, organizationId));

		revalidatePath("/dashboard/settings/organization");

		return { success: true };
	} catch (error) {
		if (error instanceof Error) {
			throw new Error(error.message);
		}
		throw new Error("Failed to remove domain");
	}
}
