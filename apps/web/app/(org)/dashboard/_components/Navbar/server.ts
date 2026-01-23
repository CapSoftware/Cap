"use server";

import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import {
	organizationMembers,
	organizations,
	users,
} from "@inflight/database/schema";
import type { Organisation } from "@inflight/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { createSpace as createSpaceAction } from "@/actions/organization/create-space";
import { updateSpace as updateSpaceAction } from "@/actions/organization/update-space";

export async function updateActiveOrganization(
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [organization] = await db()
		.select({ organization: organizations })
		.from(organizations)
		.innerJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, organizations.id),
				eq(organizationMembers.userId, user.id),
			),
		)
		.where(eq(organizations.id, organizationId));

	if (!organization) throw new Error("Organization not found");

	await db()
		.update(users)
		.set({ activeOrganizationId: organization.organization.id })
		.where(eq(users.id, user.id));

	revalidatePath("/dashboard");
}

export async function createSpace(formData: FormData) {
	try {
		const result = await createSpaceAction(formData);

		if (!result.success) {
			throw new Error(result.error || "Failed to create space");
		}

		return result;
	} catch (error) {
		console.error("Error creating space:", error);
		throw error;
	}
}

export async function updateSpace(formData: FormData) {
	try {
		const result = await updateSpaceAction(formData);
		if (!result.success) {
			throw new Error(result.error || "Failed to update space");
		}
		return result;
	} catch (error) {
		console.error("Error updating space:", error);
		throw error;
	}
}
