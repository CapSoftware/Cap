import { Effect, Layer, Option } from "effect";
import {
  InternalError,
  RpcAuthMiddleware,
  UnauthenticatedError,
} from "@cap/web-domain";

import { getCurrentUser } from "./Auth";
import { Database } from "./Database";
import { VideosRpcsLive } from "./Videos/VideosRpcs";
import { FolderRpcsLive } from "./Folders/FoldersRpcs";

export const RpcsLive = Layer.mergeAll(VideosRpcsLive, FolderRpcsLive);

export const RpcAuthMiddlewareLive = Layer.effect(
  RpcAuthMiddleware,
  Effect.gen(function* () {
    const database = yield* Database;

    return RpcAuthMiddleware.of(() =>
      getCurrentUser.pipe(
        Effect.provideService(Database, database),
        Effect.catchAll(() => new InternalError({ type: "database" })),
        Effect.flatMap(
          Option.match({
            onNone: () => new UnauthenticatedError(),
            onSome: Effect.succeed,
          })
        )
      )
    );
  })
);
