import * as Db from "@cap/database/schema";
import * as Dz from "drizzle-orm";
import { Database, S3Bucket, Video } from "@cap/web-domain";
import { Effect, Option } from "effect";

export class S3BucketsRepo extends Effect.Service<S3BucketsRepo>()(
  "S3BucketsRepo",
  {
    effect: Effect.gen(function* () {
      const db = yield* Database;

      const getForVideo = Effect.fn("S3BucketsRepo.getForVideo")(
        (videoId: Video.VideoId) =>
          Effect.gen(function* () {
            const [res] = yield* db.execute((db) =>
              db
                .select({ bucket: Db.s3Buckets })
                .from(Db.s3Buckets)
                .leftJoin(Db.videos, Dz.eq(Db.videos.bucket, Db.s3Buckets.id))
                .where(Dz.and(Dz.eq(Db.videos.id, videoId)))
            );

            return Option.fromNullable(res).pipe(
              Option.map((v) =>
                S3Bucket.decodeSync({ ...v.bucket, name: v.bucket.bucketName })
              )
            );
          })
      );

      return { getForVideo };
    }),
  }
) {}
