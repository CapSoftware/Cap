import { getServerSession } from "@cap/database/auth/auth-options";
import * as Db from "@cap/database/schema";
import { CurrentUser, HttpAuthMiddleware } from "@cap/web-domain";
import { HttpApiError, type HttpApp } from "@effect/platform";
import * as Dz from "drizzle-orm";
import { type Cause, Effect, Layer, Option } from "effect";

import { Database, type DatabaseError } from "./Database";

export const getCurrentUser = Effect.gen(function* () {
	const db = yield* Database;

	return yield* Option.fromNullable(
		yield* Effect.tryPromise(() => getServerSession()),
	).pipe(
		Option.map((session) =>
			Effect.gen(function* () {
				const [currentUser] = yield* db.execute((db) =>
					db
						.select()
						.from(Db.users)
						.where(Dz.eq(Db.users.id, (session.user as any).id)),
				);

				return Option.fromNullable(currentUser);
			}),
		),
		Effect.transposeOption,
		Effect.map(Option.flatten),
	);
}).pipe(Effect.withSpan("getCurrentUser"));

export const HttpAuthMiddlewareLive = Layer.effect(
	HttpAuthMiddleware,
	Effect.gen(function* () {
		const database = yield* Database;

		return HttpAuthMiddleware.of(
			Effect.gen(function* () {
				const user = yield* getCurrentUser.pipe(
					Effect.flatten,
					Effect.catchTag(
						"NoSuchElementException",
						() => new HttpApiError.Unauthorized(),
					),
				);

				return { id: user.id, email: user.email };
			}).pipe(
				Effect.provideService(Database, database),
				Effect.catchTags({
					UnknownException: () => new HttpApiError.InternalServerError(),
					DatabaseError: () => new HttpApiError.InternalServerError(),
				}),
			),
		);
	}),
);

export const provideOptionalAuth = <A, E, R>(
	app: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError | Cause.UnknownException, R | Database> =>
	Effect.gen(function* () {
		const user = yield* getCurrentUser;

		if (Option.isSome(user))
			yield* Effect.log(`Providing auth for user ${user.value.id}`);

		return yield* user.pipe(
			Option.map((user) =>
				CurrentUser.context({
					id: user.id,
					email: user.email,
				}),
			),
			Option.match({
				onNone: () => app,
				onSome: (ctx) => app.pipe(Effect.provide(ctx)),
			}),
		);
	});
