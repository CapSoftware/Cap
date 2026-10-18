import {
	CurrentUser,
	InternalError,
	RpcAuthMiddleware,
	UnauthenticatedError,
} from "@cap/web-domain";
import { Effect, Layer, Option } from "effect";

import { getCurrentUser, makeCurrentUser } from "./Auth.ts";
import { Database } from "./Database.ts";
import { FolderRpcsLive } from "./Folders/FoldersRpcs.ts";
import { OrganisationsRpcsLive } from "./Organisations/OrganisationsRpcs.ts";
import { UsersRpcsLive } from "./Users/UsersRpcs.ts";
import { VideosRpcsLive } from "./Videos/VideosRpcs.ts";

export const RpcsLive = Layer.mergeAll(
	VideosRpcsLive,
	FolderRpcsLive,
	UsersRpcsLive,
	OrganisationsRpcsLive,
);

export const RpcAuthMiddlewareLive = Layer.effect(
	RpcAuthMiddleware,
	Effect.gen(function* () {
		const database = yield* Database;

		return RpcAuthMiddleware.of((rpcEffect) =>
			getCurrentUser.pipe(
				Effect.provideService(Database, database),
				Effect.catch(() =>
					Effect.fail(new InternalError({ type: "database" })),
				),
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.fail(new UnauthenticatedError()),
						onSome: (user) =>
							Effect.provideService(
								rpcEffect,
								CurrentUser,
								makeCurrentUser(user),
							),
					}),
				),
			),
		);
	}),
);
