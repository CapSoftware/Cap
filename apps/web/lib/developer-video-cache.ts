import { dangerouslyDeleteByTag } from "@vercel/functions";

// Playback answers stay in the CDN cache for up to a minute. Tagging them by
// video and by app lets a delete or takedown drop them at once, so a removed
// video stops answering on the next request instead of a minute later.
export const developerVideoCacheTag = (videoId: string) =>
	`infra-video-${videoId}`;
export const developerAppCacheTag = (appId: string) => `infra-app-${appId}`;

export const CACHE_TAG_HEADER = "Vercel-Cache-Tag";

export function developerPlaybackCacheTags(video: {
	id: string;
	appId: string;
}): string {
	return [
		developerVideoCacheTag(video.id),
		developerAppCacheTag(video.appId),
	].join(",");
}

// A delete rather than an invalidate: an invalidated answer is served once
// more while it revalidates, which would show a removed video to the next
// viewer. A failed purge leaves the cache to expire on its own and never fails
// the delete.
export async function purgeDeveloperPlaybackCache(
	target: { videoId: string } | { appId: string },
): Promise<void> {
	const tag =
		"videoId" in target
			? developerVideoCacheTag(target.videoId)
			: developerAppCacheTag(target.appId);
	try {
		await dangerouslyDeleteByTag(tag);
	} catch (error) {
		console.error("[developer-video-cache] Failed to purge playback", {
			tag,
			error,
		});
	}
}
