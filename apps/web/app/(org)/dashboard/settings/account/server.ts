"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	authApiKeys,
	organizationMembers,
	organizations,
	sessions,
	users,
} from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function patchAccountSettings(
	firstName?: string,
	lastName?: string,
	defaultOrgId?: Organisation.OrganisationId,
) {
	const currentUser = await getCurrentUser();
	if (!currentUser) throw new Error("Unauthorized");

	const updatePayload: Partial<{
		name: string;
		lastName: string;
		defaultOrgId: Organisation.OrganisationId;
	}> = {};

	if (firstName !== undefined) updatePayload.name = firstName;
	if (lastName !== undefined) updatePayload.lastName = lastName;
	if (defaultOrgId !== undefined) {
		const [userOrganization] = await db()
			.select({
				id: organizations.id,
			})
			.from(organizations)
			.leftJoin(
				organizationMembers,
				and(
					eq(organizations.id, organizationMembers.organizationId),
					eq(organizationMembers.userId, currentUser.id),
				),
			)
			.where(
				and(
					eq(organizations.id, defaultOrgId),
					or(
						eq(organizations.ownerId, currentUser.id),
						eq(organizationMembers.userId, currentUser.id),
					),
				),
			)
			.limit(1);

		if (!userOrganization)
			throw new Error(
				"Forbidden: User does not have access to the specified organization",
			);

		updatePayload.defaultOrgId = defaultOrgId;
	}

	await db()
		.update(users)
		.set(updatePayload)
		.where(eq(users.id, currentUser.id));

	revalidatePath("/dashboard/settings/account");
}

export async function signOutAllDevices() {
	const currentUser = await getCurrentUser();
	if (!currentUser) throw new Error("Unauthorized");

	await db().transaction(async (tx) => {
		await tx
			.update(users)
			.set({ authSessionVersion: sql`${users.authSessionVersion} + 1` })
			.where(eq(users.id, currentUser.id));
		await tx.delete(sessions).where(eq(sessions.userId, currentUser.id));
		await tx.delete(authApiKeys).where(eq(authApiKeys.userId, currentUser.id));
	});
}
