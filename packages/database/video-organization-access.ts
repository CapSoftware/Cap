import type { User, Video } from "@cap/web-domain";
import { eq, or, sql } from "drizzle-orm";
import { db } from "./index.ts";
import {
	organizationMembers,
	organizations,
	sharedVideos,
	spaceMembers,
	spaceVideos,
	videos,
	videoViewerGrants,
} from "./schema.ts";

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

export const videoEmailAccessCondition = (user?: {
	id: User.UserId;
	email: string;
}) => {
	const unrestricted = sql<boolean>`REGEXP_LIKE(COALESCE(${organizations.allowedEmailDomain}, ''), '^[[:space:]]*$')`;
	if (!user) return unrestricted;

	const email = user.email.toLowerCase();
	const domain = email.slice(email.lastIndexOf("@") + 1);
	const escape = (value: string) =>
		value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const alternatives = [email, domain]
		.filter(
			(entry) =>
				entry.length > 0 && entry === entry.trim() && !entry.includes(","),
		)
		.map(escape)
		.join("|");
	const pattern = `(^|,)[[:space:]]*(${alternatives})[[:space:]]*(,|$)`;

	return or(
		unrestricted,
		sql`REGEXP_LIKE(COALESCE(${organizations.allowedEmailDomain}, ''), '^[[:space:],]*$')`,
		email.includes("@") && alternatives.length > 0
			? sql`REGEXP_LIKE(LOWER(${organizations.allowedEmailDomain}), ${pattern}, 'c')`
			: sql`FALSE`,
		eq(videos.ownerId, user.id),
		sql`EXISTS (
			SELECT 1 FROM ${sharedVideos} email_shared
			INNER JOIN ${organizationMembers} email_members
				ON email_shared.organizationId = email_members.organizationId
			WHERE email_shared.videoId = ${videos.id} AND email_members.userId = ${user.id}
		)`,
		sql`EXISTS (
			SELECT 1 FROM ${spaceVideos} email_space
			INNER JOIN ${spaceMembers} email_space_members
				ON email_space.spaceId = email_space_members.spaceId
			WHERE email_space.videoId = ${videos.id} AND email_space_members.userId = ${user.id}
		)`,
		sql`EXISTS (
			SELECT 1 FROM ${videoViewerGrants} email_grants
			WHERE email_grants.videoId = ${videos.id}
				AND email_grants.email = ${email.trim()} AND email_grants.revokedAt IS NULL
		)`,
	);
};
