import "server-only";

import { db } from "@cap/database";
import {
	sharedVideos,
	spaces,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import { Organisation, type User, Video } from "@cap/web-domain";
import { and, eq, exists, or } from "drizzle-orm";

export const videoBelongsToOrganization = (orgId: string) => {
	const organizationId = Organisation.OrganisationId.make(orgId);

	return or(
		eq(videos.orgId, organizationId),
		exists(
			db()
				.select({ id: sharedVideos.id })
				.from(sharedVideos)
				.where(
					and(
						eq(sharedVideos.videoId, videos.id),
						eq(sharedVideos.organizationId, organizationId),
					),
				),
		),
		exists(
			db()
				.select({ id: spaceVideos.id })
				.from(spaceVideos)
				.leftJoin(spaces, eq(spaces.id, spaceVideos.spaceId))
				.where(
					and(
						eq(spaceVideos.videoId, videos.id),
						or(
							eq(spaceVideos.spaceId, organizationId),
							eq(spaces.organizationId, organizationId),
						),
					),
				),
		),
	);
};

export const canViewCapAnalytics = async (
	userId: User.UserId,
	orgId: string,
	capId: string,
) => {
	const [video] = await db()
		.select({ id: videos.id })
		.from(videos)
		.where(
			and(
				eq(videos.id, Video.VideoId.make(capId)),
				or(eq(videos.ownerId, userId), videoBelongsToOrganization(orgId)),
			),
		)
		.limit(1);

	return Boolean(video);
};
