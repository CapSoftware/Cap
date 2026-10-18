import type { videos } from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { Option } from "effect";

type DbVideo = typeof videos.$inferSelect;

export const decodeStorageVideo = (video: DbVideo) =>
	Video.Video.make({
		...video,
		metadata: Option.fromNullable(video.metadata),
		bucketId: Option.fromNullable(video.bucket),
		storageIntegrationId: Option.fromNullable(video.storageIntegrationId),
		folderId: Option.fromNullable(video.folderId),
		transcriptionStatus: Option.fromNullable(video.transcriptionStatus),
		width: Option.fromNullable(video.width),
		height: Option.fromNullable(video.height),
		duration: Option.fromNullable(video.duration),
	});
