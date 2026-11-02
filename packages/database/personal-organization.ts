import { Organisation, type User } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { nanoId } from "./helpers.ts";
import type { db } from "./index.ts";
import { organizationMembers, organizations, users } from "./schema.ts";

type Transaction = Parameters<
	Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

export const PERSONAL_ORGANIZATION_NAME = "My Organization";

export async function createPersonalOrganization(
	tx: Transaction,
	userId: User.UserId,
) {
	const organizationId = Organisation.OrganisationId.make(nanoId());

	await tx.insert(organizations).values({
		id: organizationId,
		ownerId: userId,
		name: PERSONAL_ORGANIZATION_NAME,
	});
	await tx.insert(organizationMembers).values({
		id: nanoId(),
		organizationId,
		userId,
		role: "owner",
	});
	await tx
		.update(users)
		.set({
			activeOrganizationId: organizationId,
			defaultOrgId: organizationId,
		})
		.where(eq(users.id, userId));

	return organizationId;
}
