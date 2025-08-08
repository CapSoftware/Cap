import * as Db from "@cap/database/schema";
import * as Dz from "drizzle-orm";
import { Effect, Layer, Option } from "effect";
import { HttpApiError, HttpApp } from "@effect/platform";
import { AuthMiddleware, CurrentUser, Database } from "@cap/web-domain";
import { getServerSession } from "next-auth";
import { authOptions } from "@cap/database/auth/auth-options";

export const getCurrentUser = Effect.gen(function* () {
  const db = yield* Database;

  return yield* Option.fromNullable(
    yield* Effect.tryPromise(() => getServerSession(authOptions()))
  ).pipe(
    Option.map((session) =>
      Effect.gen(function* () {
        const [currentUser] = yield* db.execute((db) =>
          db
            .select()
            .from(Db.users)
            .where(Dz.eq(Db.users.id, (session.user as any).id))
        );

        return Option.fromNullable(currentUser);
      })
    ),
    Effect.transposeOption,
    Effect.map(Option.flatten)
  );
}).pipe(
  Effect.catchTags({
    UnknownException: () => new HttpApiError.InternalServerError(),
    DatabaseError: () => new HttpApiError.InternalServerError(),
  }),
  Effect.withSpan("getCurrentUser")
);

export const AuthMiddlewareLive = Layer.effect(
  AuthMiddleware,
  Effect.gen(function* () {
    const database = yield* Database;

    return AuthMiddleware.of(
      Effect.gen(function* () {
        const user = yield* getCurrentUser.pipe(
          Effect.andThen(
            Effect.catchTag(
              "NoSuchElementException",
              () => new HttpApiError.Unauthorized()
            )
          )
        );

        return { id: user.id, email: user.email };
      }).pipe(Effect.provideService(Database, database))
    );
  })
);

export const provideOptionalAuth = <E, R>(
  app: HttpApp.Default<E, R>
): HttpApp.Default<
  E | HttpApiError.Unauthorized | HttpApiError.InternalServerError,
  R | Database
> =>
  Effect.gen(function* () {
    const user = yield* getCurrentUser;
    return yield* user.pipe(
      Option.map((user) =>
        CurrentUser.context({
          id: user.id,
          email: user.email,
        })
      ),
      Option.match({
        onNone: () => app,
        onSome: (ctx) => app.pipe(Effect.provide(ctx)),
      })
    );
  });
