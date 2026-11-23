import { videos } from "@cap/database/schema";
import { Database, Storage } from "@cap/web-backend";
import { HttpApiError } from "@effect/platform";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { videoMetadataObject } from "./editor-metadata-sql";
import {
	knownEditorSourceDuration,
	validEditorSourceDuration,
} from "./editor-source-duration";
import {
	isMediaServerConfigured,
	probeVideoViaMediaServer,
} from "./media-client";
import { decodeStorageVideo } from "./video-storage";

type EditorVideo = typeof videos.$inferSelect;

function editorBaseSourceKey(
	video: Pick<EditorVideo, "ownerId" | "id" | "metadata">,
) {
	return (
		video.metadata?.editorSources?.display?.key ??
		`${video.ownerId}/${video.id}/result.mp4`
	);
}

// Videos replaced before Saves kept this duration are measured once.
export const resolveEditorSourceDuration = Effect.fn(
	"WebEditorCaptions.sourceDuration",
)(function* (video: EditorVideo) {
	const known = knownEditorSourceDuration(video);
	if (known !== null) return known;
	if (!isMediaServerConfigured()) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	const [bucket] = yield* Storage.getAccessForVideo(decodeStorageVideo(video), {
		resolvePublishedOutput: false,
	}).pipe(
		Effect.catchTag("StorageError", () =>
			Effect.fail(new HttpApiError.ServiceUnavailable()),
		),
	);
	const url = yield* bucket
		.getInternalSignedObjectUrl(editorBaseSourceKey(video), {
			expiresIn: 5 * 60,
		})
		.pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
	const probe = yield* Effect.tryPromise({
		try: () => probeVideoViaMediaServer(url, { maxRetries: 0 }),
		catch: () => new HttpApiError.ServiceUnavailable(),
	});
	if (!validEditorSourceDuration(probe.duration)) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	const database = yield* Database;
	yield* database
		.use((client) =>
			client
				.update(videos)
				.set({
					metadata: sql`JSON_SET(${videoMetadataObject()}, '$.editorSourceDuration', ${probe.duration})`,
					updatedAt: sql`${videos.updatedAt}`,
				})
				.where(
					and(
						eq(videos.id, video.id),
						sql`JSON_EXTRACT(${videos.metadata}, '$.editorSourceDuration') IS NULL`,
					),
				),
		)
		.pipe(Effect.ignore);
	return probe.duration;
});
