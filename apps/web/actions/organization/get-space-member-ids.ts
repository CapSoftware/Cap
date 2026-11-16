"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaceMembers } from "@cap/database/schema";
import type { Space } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { getSpaceAccess } from "./space-authorization";

/**
 * The ids of a space's current members, for its edit form. Only someone who
 * can manage the space gets them, the same check `updateSpace` makes.
 */
export async function getSpaceMemberIds(
	spaceId: Space.SpaceId,
): Promise<string[] | null> {
	const user = await getCurrentUser();
	if (!user) return null;

	const access = await getSpaceAccess(user.id, spaceId);
	if (!access?.canManage) return null;

	const members = await db()
		.select({ userId: spaceMembers.userId })
		.from(spaceMembers)
		.where(eq(spaceMembers.spaceId, spaceId));
	return members.map((member) => member.userId);
}
