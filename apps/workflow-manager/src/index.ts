import {
	NodeClusterShardManagerSocket,
	NodeRuntime,
} from "@effect/platform-node";
import { MysqlClient } from "@effect/sql-mysql2";
import { Config, Effect, Layer, Logger, Redacted } from "effect";

const DatabaseLive = Layer.unwrapEffect(
	Effect.gen(function* () {
		const url = Redacted.make(yield* Config.string("DATABASE_URL"));

		return MysqlClient.layer({ url });
	}),
);

NodeClusterShardManagerSocket.layer({
	storage: "sql",
}).pipe(
	Layer.provide(DatabaseLive),
	Layer.provide(Logger.pretty),
	Layer.launch,
	NodeRuntime.runMain,
);
