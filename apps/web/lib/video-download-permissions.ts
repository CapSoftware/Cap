import { db } from "@cap/database";
import {
	organizationMembers,
	sharedVideos,
	spaceMembers,
	spaceVideos,
} from "@cap/database/schema";
import type { Organisation, User, Video } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";

export async function canUserDownloadVideo({
	userId,
	ownerId,
	videoId,
	orgId,
}: {
	userId: User.UserId;
	ownerId: User.UserId;
	videoId: Video.VideoId;
	orgId: Organisation.OrganisationId;
}): Promise<boolean> {
	if (userId === ownerId) return true;

	const sharedOrgs = await db()
		.select({ organizationId: sharedVideos.organizationId })
		.from(sharedVideos)
		.where(eq(sharedVideos.videoId, videoId));

	const orgIds = [orgId, ...sharedOrgs.map((org) => org.organizationId)];

	const [orgMembership] = await db()
		.select({ id: organizationMembers.id })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.userId, userId),
				inArray(organizationMembers.organizationId, orgIds),
			),
		)
		.limit(1);

	if (orgMembership) return true;

	const sharedSpaces = await db()
		.select({ spaceId: spaceVideos.spaceId })
		.from(spaceVideos)
		.where(eq(spaceVideos.videoId, videoId));

	if (sharedSpaces.length === 0) return false;

	const [spaceMembership] = await db()
		.select({ id: spaceMembers.id })
		.from(spaceMembers)
		.where(
			and(
				eq(spaceMembers.userId, userId),
				inArray(
					spaceMembers.spaceId,
					sharedSpaces.map((space) => space.spaceId),
				),
			),
		)
		.limit(1);

	return Boolean(spaceMembership);
}
