import * as Db from "@cap/database/schema";
import { CurrentUser, type User } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect } from "effect";

import { ImageUploads } from "../ImageUploads";

export class Users extends Effect.Service<Users>()("Users", {
	effect: Effect.gen(function* () {
		const imageUploads = yield* ImageUploads;

		const update = Effect.fn("Users.update")(function* (
			payload: User.UserUpdate,
		) {
			const user = yield* CurrentUser;

			if (payload.image) {
				yield* imageUploads.applyUpdate({
					payload: payload.image,
					existing: user.iconUrlOrKey,
					keyPrefix: `users/${user.id}`,
					update: (db, urlOrKey) =>
						db
							.update(Db.users)
							.set({ image: urlOrKey })
							.where(Dz.eq(Db.users.id, user.id)),
				});
			}
		});

		return { update };
	}),
	dependencies: [ImageUploads.Default],
}) {}
