import { getServerSession } from "@cap/database/auth/auth-options";
import * as Db from "@cap/database/schema";
import {
	CurrentUser,
	type DatabaseError,
	HttpAuthMiddleware,
	type ImageUpload,
} from "@cap/web-domain";
import { HttpApiError, HttpServerRequest } from "@effect/platform";
import * as Dz from "drizzle-orm";
import { type Cause, Effect, Layer, Option, Schema } from "effect";

import { Database } from "./Database.ts";

export const getCurrentUser = Effect.gen(function* () {
	const db = yield* Database;

	return yield* Option.fromNullable(
		yield* Effect.tryPromise(() => getServerSession()),
	).pipe(
		Option.map((session) =>
			Effect.gen(function* () {
				const [currentUser] = yield* db.use((db) =>
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

export const makeCurrentUser = (
	user: Option.Option.Value<Effect.Effect.Success<typeof getCurrentUser>>,
) =>
	CurrentUser.of({
		id: user.id,
		email: user.email,
		activeOrganizationId: user.activeOrganizationId,
		iconUrlOrKey: Option.fromNullable(user.image),
	});

export const makeCurrentUserLayer = (
	user: Option.Option.Value<Effect.Effect.Success<typeof getCurrentUser>>,
) => Layer.succeed(CurrentUser, makeCurrentUser(user));

export const HttpAuthMiddlewareLive = Layer.effect(
	HttpAuthMiddleware,
	Effect.gen(function* () {
		const database = yield* Database;

		return HttpAuthMiddleware.of(
			Effect.gen(function* () {
				const headers = yield* HttpServerRequest.schemaHeaders(
					Schema.Struct({ authorization: Schema.optional(Schema.String) }),
				);
				const authHeader = headers.authorization?.split(" ")[1];

				let user;

				if (authHeader?.length === 36) {
					user = yield* database
						.use((db) =>
							db
								.select()
								.from(Db.users)
								.leftJoin(
									Db.authApiKeys,
									Dz.eq(Db.users.id, Db.authApiKeys.userId),
								)
								.where(Dz.eq(Db.authApiKeys.id, authHeader)),
						)
						.pipe(Effect.map(([entry]) => Option.fromNullable(entry?.users)));
				} else {
					user = yield* getCurrentUser;
				}

				return yield* user.pipe(
					Option.map(makeCurrentUser),
					Effect.catchTag(
						"NoSuchElementException",
						() => new HttpApiError.Unauthorized(),
					),
				);
			}).pipe(
				Effect.provideService(Database, database),
				Effect.catchTags({
					UnknownException: () => new HttpApiError.InternalServerError(),
					DatabaseError: () => new HttpApiError.InternalServerError(),
					ParseError: () => new HttpApiError.BadRequest(),
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

		return yield* user.pipe(
			Option.match({
				onNone: () => app,
				onSome: (user) => app.pipe(Effect.provide(makeCurrentUserLayer(user))),
			}),
		);
	});
