import { db } from "@cap/database";
import {
	organizationMembers,
	sharedVideos,
	spaceMembers,
	spaceVideos,
} from "@cap/database/schema";
import type { User, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";

// Download access must not be broader than view access. VideosPolicy.canView
// grants org members access only through an explicit sharedVideos row (see
// OrganisationsRepo.membershipForVideo), and no video-creation path writes one,
// so trusting the video's own orgId here let colleagues download recordings
// they cannot open.
export async function canUserDownloadVideo({
	userId,
	ownerId,
	videoId,
}: {
	userId: User.UserId;
	ownerId: User.UserId;
	videoId: Video.VideoId;
}): Promise<boolean> {
	if (userId === ownerId) return true;

	const [organizationMembership, spaceMembership] = await Promise.allSettled([
		db()
			.select({ id: organizationMembers.id })
			.from(sharedVideos)
			.innerJoin(
				organizationMembers,
				and(
					eq(sharedVideos.organizationId, organizationMembers.organizationId),
					eq(organizationMembers.userId, userId),
				),
			)
			.where(eq(sharedVideos.videoId, videoId))
			.limit(1),
		db()
			.select({ id: spaceMembers.id })
			.from(spaceVideos)
			.innerJoin(
				spaceMembers,
				and(
					eq(spaceVideos.spaceId, spaceMembers.spaceId),
					eq(spaceMembers.userId, userId),
				),
			)
			.where(eq(spaceVideos.videoId, videoId))
			.limit(1),
	]);

	if (organizationMembership.status === "rejected")
		throw organizationMembership.reason;
	if (organizationMembership.value[0]) return true;
	if (spaceMembership.status === "rejected") throw spaceMembership.reason;

	return Boolean(spaceMembership.value[0]);
}
