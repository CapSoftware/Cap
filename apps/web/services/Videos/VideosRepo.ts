import { Effect, Option } from "effect";
import * as Db from "@cap/database/schema";
import * as Dz from "drizzle-orm";
import { Video, Database } from "@cap/web-domain";

export class VideosRepo extends Effect.Service<VideosRepo>()("VideosRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Database;

    return {
      getById: Effect.fn(function* (id: string) {
        const [video] = yield* db.execute((db) =>
          db.select().from(Db.videos).where(Dz.eq(Db.videos.id, id))
        );

        return Option.fromNullable(video).pipe(
          Option.map((v) =>
            Video.Video.decodeSync({
              id: v.id,
              password: v.password,
              ownerId: v.ownerId,
              bucketId: v.bucket,
              source: v.source,
            })
          )
        );
      }),
    };
  }),
}) {}
