import type { videos } from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { Option } from "effect";

type DbVideo = typeof videos.$inferSelect;

export const decodeStorageVideo = (video: DbVideo) =>
	Video.Video.make({
		...video,
		metadata: Option.fromNullishOr(video.metadata),
		bucketId: Option.fromNullishOr(video.bucket),
		storageIntegrationId: Option.fromNullishOr(video.storageIntegrationId),
		folderId: Option.fromNullishOr(video.folderId),
		transcriptionStatus: Option.fromNullishOr(video.transcriptionStatus),
		width: Option.fromNullishOr(video.width),
		height: Option.fromNullishOr(video.height),
		duration: Option.fromNullishOr(video.duration),
	});
