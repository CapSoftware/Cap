import "server-only";

import { db } from "@cap/database";
import {
	sharedVideos,
	spaces,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import { Organisation, type User, Video } from "@cap/web-domain";
import { and, eq, exists, or, sql } from "drizzle-orm";

export const canViewCapAnalytics = async (
	userId: User.UserId,
	orgId: string,
	capId: string,
) => {
	const organizationId = Organisation.OrganisationId.make(orgId);
	const videoId = Video.VideoId.make(capId);

	const [video] = await db()
		.select({
			orgId: videos.orgId,
			ownerId: videos.ownerId,
			sharedWithOrganization: sql<number>`${exists(
				db()
					.select({ id: sharedVideos.id })
					.from(sharedVideos)
					.where(
						and(
							eq(sharedVideos.videoId, videoId),
							eq(sharedVideos.organizationId, organizationId),
						),
					),
			)}`,
			inOrganizationSpace: sql<number>`${exists(
				db()
					.select({ id: spaceVideos.id })
					.from(spaceVideos)
					.leftJoin(spaces, eq(spaces.id, spaceVideos.spaceId))
					.where(
						and(
							eq(spaceVideos.videoId, videoId),
							or(
								eq(spaceVideos.spaceId, organizationId),
								eq(spaces.organizationId, organizationId),
							),
						),
					),
			)}`,
		})
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);

	if (!video) return false;

	return (
		video.orgId === organizationId ||
		video.ownerId === userId ||
		Number(video.sharedWithOrganization) === 1 ||
		Number(video.inOrganizationSpace) === 1
	);
};
