import "server-only";

import { db } from "@cap/database";
import { importedVideos, users, videos } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { type User, Video } from "@cap/web-domain";
import {
	and,
	count,
	eq,
	exists,
	gte,
	lt,
	notExists,
	or,
	type SQL,
} from "drizzle-orm";

const monthStartUtc = (reference: Date) =>
	new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1));

const quotaWindowStart = (reference: Date) => {
	const start = monthStartUtc(reference);
	return start > Video.SHAREABLE_LINK_LIMIT_ENFORCED_FROM
		? start
		: Video.SHAREABLE_LINK_LIMIT_ENFORCED_FROM;
};

// Imported videos (Loom migrations) were already shared before they reached
// Cap, so they neither use up the allowance nor get locked by it.
const isImported = (videoId: SQL | typeof videos.id | Video.VideoId) =>
	db()
		.select({ id: importedVideos.id })
		.from(importedVideos)
		.where(eq(importedVideos.id, videoId));

/**
 * A video is over quota when 25 or more of the owner's videos were created
 * earlier in the same calendar month (UTC). The flag is derived from creation
 * order, so it sticks to the video across month boundaries, disappears the
 * moment the owner upgrades (callers skip the check for Pro owners), and
 * frees up if earlier videos from that month are deleted. Imported videos
 * are never over quota and do not count towards it.
 */
export async function isVideoOverShareableLinkLimit(video: {
	id: Video.VideoId;
	ownerId: User.UserId;
	createdAt: Date;
	isScreenshot: boolean;
}): Promise<boolean> {
	if (video.isScreenshot) return false;
	if (video.createdAt < Video.SHAREABLE_LINK_LIMIT_ENFORCED_FROM) return false;

	const [row] = await db()
		.select({
			earlier: count(),
			imported: exists(isImported(video.id)).mapWith(
				(value) => Number(value) > 0,
			),
		})
		.from(videos)
		.where(
			and(
				eq(videos.ownerId, video.ownerId),
				eq(videos.isScreenshot, false),
				notExists(isImported(videos.id)),
				gte(videos.createdAt, quotaWindowStart(video.createdAt)),
				or(
					lt(videos.createdAt, video.createdAt),
					and(eq(videos.createdAt, video.createdAt), lt(videos.id, video.id)),
				),
			),
		);

	if (!row || row.imported) return false;

	return row.earlier >= Video.FREE_PLAN_SHAREABLE_LINKS_PER_MONTH;
}

export async function isVideoLockedByShareableLinkLimit(
	videoId: Video.VideoId,
): Promise<boolean> {
	const [video] = await db()
		.select({
			ownerId: videos.ownerId,
			createdAt: videos.createdAt,
			isScreenshot: videos.isScreenshot,
			stripeSubscriptionStatus: users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
		})
		.from(videos)
		.leftJoin(users, eq(users.id, videos.ownerId))
		.where(eq(videos.id, videoId))
		.limit(1);

	if (!video || userIsPro(video)) return false;

	return isVideoOverShareableLinkLimit({ id: videoId, ...video });
}

export async function getShareableLinkUsage(userId: User.UserId): Promise<{
	used: number;
	limit: number;
}> {
	const [row] = await db()
		.select({ used: count() })
		.from(videos)
		.where(
			and(
				eq(videos.ownerId, userId),
				eq(videos.isScreenshot, false),
				notExists(isImported(videos.id)),
				gte(videos.createdAt, quotaWindowStart(new Date())),
			),
		);

	return {
		used: row?.used ?? 0,
		limit: Video.FREE_PLAN_SHAREABLE_LINKS_PER_MONTH,
	};
}
