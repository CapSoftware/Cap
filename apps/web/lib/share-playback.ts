import type { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { type User, Video } from "@cap/web-domain";
import { Effect, Option, Schema } from "effect";
import { runPromise } from "@/lib/server";

type SharePlaybackVideo = Omit<
	typeof videos.$inferSelect,
	"folderId" | "password" | "settings" | "ownerId"
> & { owner: { id: User.UserId } };

export type SharePlaybackSource = {
	url: string;
	// Cap's own bucket, not a custom bucket or a storage integration.
	defaultStorage: boolean;
};

export const getSharePlaybackSource = (
	video: SharePlaybackVideo,
): Promise<SharePlaybackSource | null> =>
	Effect.gen(function* () {
		const loadedVideo = yield* Schema.decodeUnknown(Video.Video)({
			...video,
			ownerId: video.owner.id,
			bucketId: video.bucket,
			folderId: null,
			createdAt: video.createdAt.toISOString(),
			updatedAt: video.updatedAt.toISOString(),
		});
		const [bucket, customBucket] =
			yield* Storage.getAccessForVideo(loadedVideo);
		const source = Video.Video.getSource(loadedVideo);
		if (!(source instanceof Video.Mp4Source)) return null;
		const url = yield* bucket.getSignedObjectUrl(source.getFileKey());
		return {
			url,
			defaultStorage:
				Option.isNone(customBucket) &&
				Option.isNone(loadedVideo.storageIntegrationId),
		};
	})
		.pipe(runPromise)
		.catch(() => null);

export const getSharePlaybackUrl = (video: SharePlaybackVideo) =>
	getSharePlaybackSource(video).then((source) => source?.url ?? null);

// iOS Safari may need the player to rewrite an MP4's AVC level before it can
// decode it, and iPadOS reports a desktop Safari user agent. Those browsers
// keep resolving the source after hydration, where that check runs first.
export function canStartPlaybackInHtml(userAgent: string | null): boolean {
	if (!userAgent) return false;
	const ua = userAgent.toLowerCase();
	if (/iphone|ipod|ipad/.test(ua)) return false;
	const isDesktopSafari =
		ua.includes("macintosh") &&
		ua.includes("safari/") &&
		!/chrome\/|chromium\/|crios\/|fxios\/|edg\/|firefox\//.test(ua);
	return !isDesktopSafari;
}
