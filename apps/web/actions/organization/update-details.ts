"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationSettingsManager } from "./authorization";

export async function updateOrganizationDetails({
	organizationName,
	allowedEmailDomain,
	allowPublicLinkOverride,
	organizationId,
}: {
	organizationName?: string | null;
	allowedEmailDomain?: string | null;
	allowPublicLinkOverride?: boolean;
	organizationId: Organisation.OrganisationId;
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

	await requireOrganizationSettingsManager(user.id, organizationId);

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

	if (typeof allowPublicLinkOverride === "boolean") {
		await db()
			.update(organizations)
			.set({
				settings: sql`JSON_MERGE_PATCH(COALESCE(${organizations.settings}, JSON_OBJECT()), CAST(${JSON.stringify({ allowPublicLinkOverride })} AS JSON))`,
			})
			.where(eq(organizations.id, organizationId));
	}

	revalidatePath("/dashboard/settings/organization");

	return { success: true };
}
