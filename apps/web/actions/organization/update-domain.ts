"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { addDomain, checkDomainStatus } from "./domain-utils";

export async function updateDomain(domain: string, organizationId: string) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	//check user subscription to prevent abuse
	const isSubscribed = user.stripeSubscriptionStatus === "active";

	if (!isSubscribed) {
		throw new Error("User is not subscribed");
	}

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId));

	if (!organization || organization.ownerId !== user.id) {
		throw new Error("Only the owner can update the custom domain");
	}

	// Check if domain is already being used by another organization
	const existingDomain = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.customDomain, domain))
		.limit(1);

	if (existingDomain.length > 0 && existingDomain[0]?.id !== organizationId) {
		throw new Error("This domain is already being used.");
	}

	try {
		const addDomainResponse = await addDomain(domain);

		if (addDomainResponse.error) {
			throw new Error(addDomainResponse.error.message);
		}

		await db()
			.update(organizations)
			.set({
				customDomain: domain,
				domainVerified: null,
			})
			.where(eq(organizations.id, organizationId));

		const status = await checkDomainStatus(domain);

		if (status.verified) {
			await db()
				.update(organizations)
				.set({
					domainVerified: new Date(),
				})
				.where(eq(organizations.id, organizationId));
		}

		revalidatePath("/dashboard/settings/organization");

		return status;
	} catch (error) {
		if (error instanceof Error) {
			throw new Error(error.message);
		}
	}
}
