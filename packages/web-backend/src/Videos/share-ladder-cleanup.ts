import * as Db from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect } from "effect";
import { AwsCredentials } from "../Aws.ts";
import type { Database } from "../Database.ts";
import {
	invalidateCloudFrontPaths,
	shareLadderCdnPaths,
} from "../S3Buckets/cloudfront-invalidation.ts";

// The ladder files live under the video's folder, so the caller's folder
// delete removes them. This purges the CDN copies of every published ladder,
// then drops the rows. A purge that still fails after its retries is logged:
// ladder media is only reachable through signed URLs that expire within an
// hour, the same as the MP4.
export const forgetShareLadders = (
	db: Database,
	videoIds: readonly Video.VideoId[],
): Effect.Effect<void> =>
	Effect.gen(function* () {
		if (videoIds.length === 0) return;
		const rows = yield* db.use((db) =>
			db
				.select({
					videoId: Db.shareLadders.videoId,
					outputPrefix: Db.shareLadders.outputPrefix,
				})
				.from(Db.shareLadders)
				.where(Dz.inArray(Db.shareLadders.videoId, [...videoIds])),
		);
		if (rows.length === 0) return;
		const paths = rows.flatMap((row) =>
			row.outputPrefix ? shareLadderCdnPaths(row.outputPrefix) : [],
		);
		yield* invalidateCloudFrontPaths(paths).pipe(
			Effect.provide(AwsCredentials.Default),
			Effect.catchAllCause((cause) =>
				Effect.logError("Failed to purge share ladders from the CDN", cause),
			),
		);
		yield* db.use((db) =>
			db.delete(Db.shareLadders).where(
				Dz.inArray(
					Db.shareLadders.videoId,
					rows.map((row) => row.videoId),
				),
			),
		);
	}).pipe(
		Effect.catchAllCause((cause) =>
			Effect.logError("Failed to forget share ladders", cause),
		),
	);
