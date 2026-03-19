import {
	NodeClusterShardManagerSocket,
	NodeRuntime,
} from "@effect/platform-node";
import { Layer, Logger } from "effect";

import { DatabaseLive, ShardDatabaseLive } from "./shared/database.ts";

NodeClusterShardManagerSocket.layer({
	storage: "sql",
}).pipe(
	Layer.provide(ShardDatabaseLive),
	Layer.provide(DatabaseLive),
	Layer.provide(Logger.pretty),
	Layer.launch,
	NodeRuntime.runMain,
);
