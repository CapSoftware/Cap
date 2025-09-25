import {
	InternalError,
	RpcAuthMiddleware,
	UnauthenticatedError,
} from "@cap/web-domain";
import { Effect, Layer, Option } from "effect";

import { getCurrentUser } from "./Auth.ts";
import { Database } from "./Database.ts";
import { FolderRpcsLive } from "./Folders/FoldersRpcs.ts";
import { VideosRpcsLive } from "./Videos/VideosRpcs.ts";

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
						onSome: (user) =>
							Effect.succeed({
								id: user.id,
								email: user.email,
								activeOrganizationId: user.activeOrganizationId,
							}),
					}),
				),
			),
		);
	}),
);
