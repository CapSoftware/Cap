import type { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { type User, Video } from "@cap/web-domain";
import { Effect, Schema } from "effect";
import { runPromise } from "@/lib/server";

type SharePlaybackVideo = Omit<
	typeof videos.$inferSelect,
	"folderId" | "password" | "settings" | "ownerId"
> & { owner: { id: User.UserId } };

export const getSharePlaybackUrl = (video: SharePlaybackVideo) =>
	Effect.gen(function* () {
		const loadedVideo = yield* Schema.decodeUnknown(Video.Video)({
			...video,
			ownerId: video.owner.id,
			bucketId: video.bucket,
			folderId: null,
			createdAt: video.createdAt.toISOString(),
			updatedAt: video.updatedAt.toISOString(),
		});
		const [bucket] = yield* Storage.getAccessForVideo(loadedVideo);
		return yield* bucket.getSignedObjectUrl(
			`${video.owner.id}/${video.id}/result.mp4`,
		);
	})
		.pipe(runPromise)
		.catch(() => null);
