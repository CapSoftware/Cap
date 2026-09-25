import type { User, Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { db } from "./index.ts";
import { organizationMembers, organizations, videos } from "./schema.ts";

export const organizationVideoAccessCondition = (userId: User.UserId) =>
	sql<boolean>`NOT EXISTS (
		SELECT 1 FROM ${organizations}
		WHERE ${organizations.id} = ${videos.orgId}
		AND ${organizations.videoSharingRestrictedToOrg} = TRUE
		AND (
			${organizations.tombstoneAt} IS NOT NULL
			OR (
				${organizations.ownerId} <> ${userId}
				AND NOT EXISTS (
					SELECT 1 FROM ${organizationMembers}
					WHERE ${organizationMembers.organizationId} = ${organizations.id}
					AND ${organizationMembers.userId} = ${userId}
				)
			)
		)
	)`;

export async function getVideoOrganizationAccess(
	videoId: Video.VideoId,
	userId: User.UserId,
) {
	const [video] = await db()
		.select({
			restricted: organizations.videoSharingRestrictedToOrg,
			allowed: organizationVideoAccessCondition(userId).mapWith(Boolean),
		})
		.from(videos)
		.innerJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId))
		.limit(1);
	return video;
}
