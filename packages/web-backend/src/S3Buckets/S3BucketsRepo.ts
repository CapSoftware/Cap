import * as Db from "@cap/database/schema";
import {
	type Organisation,
	S3Bucket,
	type User,
	type Video,
} from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";

import { Database } from "../Database.ts";

const makeS3BucketsRepo = Effect.gen(function* () {
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

				return Option.fromNullishOr(res).pipe(
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

				return Option.fromNullishOr(res).pipe(
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
						.where(
							Dz.and(
								Dz.eq(Db.s3Buckets.ownerId, userId),
								Dz.isNull(Db.s3Buckets.organizationId),
								Dz.eq(Db.s3Buckets.active, true),
							),
						)
						.orderBy(Dz.desc(Db.s3Buckets.updatedAt)),
				);

				return Option.fromNullishOr(res).pipe(
					Option.map((v) =>
						S3Bucket.decodeSync({ ...v.bucket, name: v.bucket.bucketName }),
					),
				);
			}),
	);

	const getForOrganization = Effect.fn("S3BucketsRepo.getForOrganization")(
		(organizationId: Organisation.OrganisationId) =>
			Effect.gen(function* () {
				const [res] = yield* db.use((db) =>
					db
						.select({ bucket: Db.s3Buckets })
						.from(Db.s3Buckets)
						.where(
							Dz.and(
								Dz.eq(Db.s3Buckets.organizationId, organizationId),
								Dz.eq(Db.s3Buckets.active, true),
							),
						)
						.orderBy(Dz.desc(Db.s3Buckets.updatedAt)),
				);

				return Option.fromNullishOr(res).pipe(
					Option.map((v) =>
						S3Bucket.decodeSync({ ...v.bucket, name: v.bucket.bucketName }),
					),
				);
			}),
	);

	return { getForVideo, getById, getForUser, getForOrganization };
});

export class S3BucketsRepo extends Context.Service<
	S3BucketsRepo,
	Effect.Success<typeof makeS3BucketsRepo>
>()("S3BucketsRepo") {
	static readonly Default = Layer.effect(this, makeS3BucketsRepo).pipe(
		Layer.provide(Layer.mergeAll(Database.Default)),
	);
}
