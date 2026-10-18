import { serverEnv } from "@cap/env";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { db } from "./index.ts";
import { organizations } from "./schema.ts";

export async function getNewVideoPublic(
	organizationId: Organisation.OrganisationId,
): Promise<boolean> {
	const [organization] = await db()
		.select({
			defaultVideoVisibility: organizations.defaultVideoVisibility,
			tombstoneAt: organizations.tombstoneAt,
		})
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);

	if (!organization || organization.tombstoneAt) {
		throw new Error("Organization not found");
	}

	if (organization.defaultVideoVisibility === "private") return false;
	return serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC;
}
