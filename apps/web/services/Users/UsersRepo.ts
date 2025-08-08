import * as Db from "@cap/database/schema";
import * as Dz from "drizzle-orm";
import { Database } from "@cap/web-domain";
import { Effect } from "effect";

export class UsersRepo extends Effect.Service<UsersRepo>()("UsersRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Database;

    return {
      getById: (id: string) =>
        db.execute((db) =>
          db.select().from(Db.users).where(Dz.eq(Db.users.id, id))
        ),
    };
  }),
}) {}
