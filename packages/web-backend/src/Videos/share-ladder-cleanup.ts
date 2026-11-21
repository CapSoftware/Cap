import * as Db from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect } from "effect";
import { AwsCredentials } from "../Aws.ts";
import type { Database } from "../Database.ts";
import {
	invalidateCloudFrontPaths,
	shareLadderCdnPath,
} from "../S3Buckets/cloudfront-invalidation.ts";

// CloudFront allows 15 wildcard paths in progress at once.
const CLOUDFRONT_PATHS_PER_INVALIDATION = 15;

// The ladder files live under the video's folder, so the caller's folder
// delete removes them. This drops the rows and purges the CDN copies.
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
					ownerId: Db.shareLadders.ownerId,
				})
				.from(Db.shareLadders)
				.where(Dz.inArray(Db.shareLadders.videoId, [...videoIds])),
		);
		if (rows.length === 0) return;
		yield* db.use((db) =>
			db.delete(Db.shareLadders).where(
				Dz.inArray(
					Db.shareLadders.videoId,
					rows.map((row) => row.videoId),
				),
			),
		);
		const paths = rows.map((row) =>
			shareLadderCdnPath(row.ownerId, row.videoId),
		);
		for (
			let index = 0;
			index < paths.length;
			index += CLOUDFRONT_PATHS_PER_INVALIDATION
		) {
			yield* invalidateCloudFrontPaths(
				paths.slice(index, index + CLOUDFRONT_PATHS_PER_INVALIDATION),
			);
		}
	}).pipe(
		Effect.provide(AwsCredentials.Default),
		Effect.catchAllCause((cause) =>
			Effect.logError("Failed to forget share ladders", cause),
		),
	);
