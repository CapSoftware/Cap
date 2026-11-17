import { db } from "@cap/database";
import {
	organizations,
	spaces,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import { resolveEffectiveVideoRules } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";

export async function isVideoFeedbackDisabled(
	videoId: Video.VideoId,
	setting: "disableComments" | "disableReactions",
) {
	const [[video], sharedSpaces] = await Promise.all([
		db()
			.select({
				videoSettings: videos.settings,
				organizationSettings: organizations.settings,
			})
			.from(videos)
			.leftJoin(organizations, eq(organizations.id, videos.orgId))
			.where(eq(videos.id, videoId))
			.limit(1),
		db()
			.select({
				id: spaces.id,
				name: spaces.name,
				organizationId: spaces.organizationId,
				settings: spaces.settings,
			})
			.from(spaceVideos)
			.innerJoin(spaces, eq(spaceVideos.spaceId, spaces.id))
			.where(eq(spaceVideos.videoId, videoId)),
	]);

	return resolveEffectiveVideoRules({
		videoSettings: video?.videoSettings,
		organizationSettings: video?.organizationSettings,
		spaces: sharedSpaces.filter((space) => space.id !== space.organizationId),
	}).settings[setting];
}
