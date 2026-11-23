import { db } from "@cap/database";
import {
	organizationMembers,
	organizations,
	sharedVideos,
	spaceMembers,
	spaceVideos,
} from "@cap/database/schema";
import type { Organisation, User, Video } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";

type ViewerDownloadSettings = { disableDownloads?: boolean } | null | undefined;

// Viewers can download by default. The organization can turn it off for every
// cap and the owner for a single cap, and either one being off wins. This only
// decides whether viewers may download at all: callers still run the view gates
// (privacy, email restriction, password, share limit) before signing a URL.
export function areViewerDownloadsEnabled({
	videoSettings,
	organizationSettings,
}: {
	videoSettings: ViewerDownloadSettings;
	organizationSettings: ViewerDownloadSettings;
}): boolean {
	return (
		organizationSettings?.disableDownloads !== true &&
		videoSettings?.disableDownloads !== true
	);
}

export async function videoAllowsViewerDownloads(video: {
	orgId: Organisation.OrganisationId;
	settings: ViewerDownloadSettings;
}): Promise<boolean> {
	if (video.settings?.disableDownloads === true) return false;

	const [organization] = await db()
		.select({ settings: organizations.settings })
		.from(organizations)
		.where(
			and(eq(organizations.id, video.orgId), isNull(organizations.tombstoneAt)),
		);
	if (!organization) return false;

	return areViewerDownloadsEnabled({
		videoSettings: video.settings,
		organizationSettings: organization.settings,
	});
}

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
