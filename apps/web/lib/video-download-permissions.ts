import { db } from "@cap/database";
import {
	directoryAccessAllowed,
	directorySpaceAccessAllowed,
} from "@cap/database/directory-sync/access";
import {
	organizationMembers,
	sharedVideos,
	spaceMembers,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import type { User, Video } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";

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
	const [video] = await db()
		.select({ allowed: directoryAccessAllowed(userId, videos.orgId) })
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);
	if (!video) return false;
	if (userId === ownerId && video.allowed) return true;

	const sharedOrgs = await db()
		.select({ organizationId: sharedVideos.organizationId })
		.from(sharedVideos)
		.where(eq(sharedVideos.videoId, videoId));

	if (sharedOrgs.length > 0) {
		const [orgMembership] = await db()
			.select({ id: organizationMembers.id })
			.from(organizationMembers)
			.where(
				and(
					and(
						eq(organizationMembers.userId, userId),
						directoryAccessAllowed(userId, organizationMembers.organizationId),
					),
					inArray(
						organizationMembers.organizationId,
						sharedOrgs.map((org) => org.organizationId),
					),
				),
			)
			.limit(1);

		if (orgMembership) return true;
	}

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
				and(
					eq(spaceMembers.userId, userId),
					directorySpaceAccessAllowed(userId, spaceMembers.spaceId),
				),
				inArray(
					spaceMembers.spaceId,
					sharedSpaces.map((space) => space.spaceId),
				),
			),
		)
		.limit(1);

	return Boolean(spaceMembership);
}
