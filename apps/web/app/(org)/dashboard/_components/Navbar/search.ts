"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationMembers,
	organizations,
	sharedVideos,
	spaceMembers,
	spaces,
	spaceVideos,
	users,
	videos,
} from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

const MAX_VIDEO_RESULTS = 8;
const MIN_VIDEO_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 80;
const LIKE_ESCAPE = "!";

export type DashboardVideoSearchResult = {
	id: Video.VideoId;
	name: string;
	ownerName: string | null;
	createdAt: string;
	duration: number | null;
	isScreenshot: boolean;
};

const normalizeSearchQuery = (query: string) =>
	query.trim().replace(/\s+/g, " ").slice(0, MAX_QUERY_LENGTH);
const escapeLikePattern = (value: string) =>
	value.replace(/[!%_]/g, (match) => `${LIKE_ESCAPE}${match}`);

export async function searchDashboardVideos(
	query: string,
): Promise<DashboardVideoSearchResult[]> {
	const user = await getCurrentUser();
	const activeOrganizationId = user?.activeOrganizationId;
	const normalizedQuery = normalizeSearchQuery(query);

	if (
		!user ||
		!activeOrganizationId ||
		normalizedQuery.length < MIN_VIDEO_QUERY_LENGTH
	) {
		return [];
	}

	const database = db();
	const escapedQuery = escapeLikePattern(normalizedQuery);
	const containsPattern = `%${escapedQuery}%`;
	const startsWithPattern = `${escapedQuery}%`;
	const organizationMembershipIds = database
		.select({ organizationId: organizationMembers.organizationId })
		.from(organizationMembers)
		.where(eq(organizationMembers.userId, user.id));
	const sharedVideoIds = database
		.select({ videoId: sharedVideos.videoId })
		.from(sharedVideos)
		.where(eq(sharedVideos.organizationId, activeOrganizationId));
	const accessibleSpaceVideoIds = database
		.select({ videoId: spaceVideos.videoId })
		.from(spaceVideos)
		.innerJoin(spaces, eq(spaceVideos.spaceId, spaces.id))
		.where(
			and(
				eq(spaces.organizationId, activeOrganizationId),
				or(
					eq(spaces.createdById, user.id),
					eq(spaces.privacy, "Public"),
					inArray(
						spaces.id,
						database
							.select({ spaceId: spaceMembers.spaceId })
							.from(spaceMembers)
							.where(eq(spaceMembers.userId, user.id)),
					),
				),
			),
		);

	const rows = await database
		.select({
			id: videos.id,
			name: videos.name,
			ownerName: users.name,
			createdAt: videos.createdAt,
			duration: videos.duration,
			isScreenshot: videos.isScreenshot,
		})
		.from(videos)
		.innerJoin(organizations, eq(videos.orgId, organizations.id))
		.leftJoin(users, eq(videos.ownerId, users.id))
		.where(
			and(
				eq(videos.orgId, activeOrganizationId),
				isNull(organizations.tombstoneAt),
				or(
					eq(organizations.ownerId, user.id),
					inArray(organizations.id, organizationMembershipIds),
				),
				sql`${videos.name} LIKE ${containsPattern} ESCAPE '!'`,
				or(
					eq(videos.ownerId, user.id),
					inArray(videos.id, sharedVideoIds),
					inArray(videos.id, accessibleSpaceVideoIds),
				),
			),
		)
		.orderBy(
			sql`CASE WHEN ${videos.name} LIKE ${startsWithPattern} ESCAPE '!' THEN 0 ELSE 1 END`,
			desc(videos.effectiveCreatedAt),
		)
		.limit(MAX_VIDEO_RESULTS);

	return rows.map((row) => ({
		...row,
		createdAt: row.createdAt.toISOString(),
		duration: row.duration ?? null,
	}));
}
