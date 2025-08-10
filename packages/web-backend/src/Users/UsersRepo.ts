import * as Db from "@cap/database/schema";
import * as Dz from "drizzle-orm";
import { Effect } from "effect";

import { Database } from "../Database";

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
