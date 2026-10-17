import { getServerSession } from "@cap/database/auth/auth-options";
import { isBlockedAccountEmail } from "@cap/database/auth/domain-utils";
import * as Db from "@cap/database/schema";
import {
	CurrentUser,
	type DatabaseError,
	HttpAuthMiddleware,
	UserId,
} from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { type Cause, Effect, Layer, Option, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiError } from "effect/http-api";

import { Database } from "./Database.ts";

export const getCurrentUser = Effect.gen(function* () {
	const db = yield* Database;

	return yield* Option.fromNullishOr(
		yield* Effect.tryPromise(() => getServerSession()),
	).pipe(
		Option.map((session) =>
			Effect.gen(function* () {
				const [currentUser] = yield* db.use((db) =>
					db
						.select()
						.from(Db.users)
						.where(
							Dz.eq(
								Db.users.id,
								UserId.make((session.user as { id: string }).id),
							),
						),
				);

				return Option.fromNullishOr(currentUser);
			}),
		),
		Effect.transposeOption,
		Effect.map(Option.flatten),
	);
}).pipe(Effect.withSpan("getCurrentUser"));

export const makeCurrentUser = (
	user: Option.Option.Value<Effect.Success<typeof getCurrentUser>>,
) =>
	CurrentUser.of({
		id: user.id,
		email: user.email,
		activeOrganizationId: user.activeOrganizationId,
		iconUrlOrKey: Option.fromNullishOr(user.image),
	});

export const makeCurrentUserLayer = (
	user: Option.Option.Value<Effect.Success<typeof getCurrentUser>>,
) => Layer.succeed(CurrentUser, makeCurrentUser(user));

export const HttpAuthMiddlewareLive = Layer.effect(
	HttpAuthMiddleware,
	Effect.gen(function* () {
		const database = yield* Database;

		return HttpAuthMiddleware.of((httpEffect) =>
			Effect.gen(function* () {
				const headers = yield* HttpServerRequest.schemaHeaders(
					Schema.Struct({ authorization: Schema.optional(Schema.String) }),
				);
				const authHeader = headers.authorization?.split(" ")[1];

				let user: Option.Option<typeof Db.users.$inferSelect>;

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
						.pipe(
							Effect.map(([entry]) =>
								Option.fromNullishOr(entry?.users).pipe(
									Option.filter((user) => !isBlockedAccountEmail(user.email)),
								),
							),
						);
				} else {
					user = yield* getCurrentUser;
				}

				return yield* Effect.fromOption(
					user,
					() => new HttpApiError.Unauthorized(),
				).pipe(Effect.map(makeCurrentUser));
			}).pipe(
				Effect.provideService(Database, database),
				Effect.catchTags({
					UnknownError: () =>
						Effect.fail(new HttpApiError.InternalServerError()),
					DatabaseError: () =>
						Effect.fail(new HttpApiError.InternalServerError()),
					SchemaError: () => Effect.fail(new HttpApiError.BadRequest()),
				}),
				Effect.flatMap((user) =>
					Effect.provideService(httpEffect, CurrentUser, user),
				),
			),
		);
	}),
);

export const provideOptionalAuth = <A, E, R>(
	app: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError | Cause.UnknownError, R | Database> =>
	Effect.gen(function* () {
		const user = yield* getCurrentUser;

		return yield* user.pipe(
			Option.match({
				onNone: () => app,
				onSome: (user) => app.pipe(Effect.provide(makeCurrentUserLayer(user))),
			}),
		);
	});
