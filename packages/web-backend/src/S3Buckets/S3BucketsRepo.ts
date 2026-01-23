import * as Db from "@inflight/database/schema";
import { S3Bucket, type User, type Video } from "@inflight/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option } from "effect";

import { Database } from "../Database.ts";

export class S3BucketsRepo extends Effect.Service<S3BucketsRepo>()(
	"S3BucketsRepo",
	{
		effect: Effect.gen(function* () {
			const db = yield* Database;

			const getForVideo = Effect.fn("S3BucketsRepo.getForVideo")(
				(videoId: Video.VideoId) =>
					Effect.gen(function* () {
						const [res] = yield* db.use((db) =>
							db
								.select({ bucket: Db.s3Buckets })
								.from(Db.s3Buckets)
								.leftJoin(Db.videos, Dz.eq(Db.videos.bucket, Db.s3Buckets.id))
								.where(Dz.and(Dz.eq(Db.videos.id, videoId))),
						);

						return Option.fromNullable(res).pipe(
							Option.map((v) =>
								S3Bucket.decodeSync({ ...v.bucket, name: v.bucket.bucketName }),
							),
						);
					}),
			);

			const getById = Effect.fn("S3BucketsRepo.getById")(
				(id: S3Bucket.S3BucketId) =>
					Effect.gen(function* () {
						const [res] = yield* db.use((db) =>
							db
								.select({ bucket: Db.s3Buckets })
								.from(Db.s3Buckets)
								.where(Dz.eq(Db.s3Buckets.id, id)),
						);

						return Option.fromNullable(res).pipe(
							Option.map((v) =>
								S3Bucket.decodeSync({ ...v.bucket, name: v.bucket.bucketName }),
							),
						);
					}),
			);

			const getForUser = Effect.fn("S3BucketsRepo.getForUser")(
				(userId: User.UserId) =>
					Effect.gen(function* () {
						const [res] = yield* db.use((db) =>
							db
								.select({ bucket: Db.s3Buckets })
								.from(Db.s3Buckets)
								.where(Dz.eq(Db.s3Buckets.ownerId, userId)),
						);

						return Option.fromNullable(res).pipe(
							Option.map((v) =>
								S3Bucket.decodeSync({ ...v.bucket, name: v.bucket.bucketName }),
							),
						);
					}),
			);

			return { getForVideo, getById, getForUser };
		}),
		dependencies: [Database.Default],
	},
) {}
