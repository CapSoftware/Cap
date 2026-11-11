import "server-only";

import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { VideosPolicy } from "@cap/web-backend";
import { CurrentUser, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { runPromise } from "@/lib/server";
import { isVideoLockedByShareableLinkLimit } from "@/lib/shareable-link-quota";
import {
	canUserDownloadVideo,
	videoAllowsViewerDownloads,
} from "@/lib/video-download-permissions";
import { decodeStorageVideo } from "@/lib/video-storage";

export type VideoDownloadVariant = "current" | "original";

export type VideoDownloadAccess =
	| "member"
	| "viewer"
	| "denied"
	| "rate_limited";

type VideoRow = typeof videos.$inferSelect;
type Viewer = Option.Option<CurrentUser["Type"]>;

// The same gates the share page applies before it shows the video: privacy,
// email restriction, link access and password through the view policy, then
// the free plan share limit.
async function viewerPassesViewGates(video: VideoRow, viewer: Viewer) {
	const check = Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;
		yield* videosPolicy.canViewLoaded(
			decodeStorageVideo(video),
			Option.fromNullable(video.password),
		);
		return true;
	});
	const canView = await (Option.isSome(viewer)
		? check.pipe(Effect.provideService(CurrentUser, viewer.value))
		: check
	)
		.pipe(runPromise)
		.catch(() => false);
	if (!canView) return false;

	return !(await isVideoLockedByShareableLinkLimit(video.id));
}

// Owners and members of an organization or space the cap is shared with keep
// every download they had, including the original. Everyone else is a viewer:
// they only ever get the published video, and only when downloads are on for
// the cap and they pass every gate that viewing it requires.
export async function resolveVideoDownloadAccess({
	viewer,
	video,
	variant,
}: {
	viewer: Viewer;
	video: VideoRow;
	variant: VideoDownloadVariant;
}): Promise<VideoDownloadAccess> {
	if (
		Option.isSome(viewer) &&
		(await canUserDownloadVideo({
			userId: viewer.value.id,
			ownerId: video.ownerId,
			videoId: video.id,
		}))
	) {
		return "member";
	}

	if (variant !== "current" || video.isScreenshot) return "denied";
	if (await isRateLimited(RATE_LIMIT_IDS.VIEWER_DOWNLOAD)) {
		return "rate_limited";
	}
	if (!(await videoAllowsViewerDownloads(video))) return "denied";

	return (await viewerPassesViewGates(video, viewer)) ? "viewer" : "denied";
}

export async function currentVideoDownloadAccess(
	videoId: Video.VideoId,
	viewer: Viewer,
): Promise<"member" | "viewer" | "denied"> {
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));
	if (!video) return "denied";

	const access = await resolveVideoDownloadAccess({
		viewer,
		video,
		variant: "current",
	});
	return access === "member" || access === "viewer" ? access : "denied";
}
