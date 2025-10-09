import { MysqlClient } from "@effect/sql-mysql2";
import { Config, Effect, Layer, Option, Redacted } from "effect";

export const DatabaseLive = Layer.unwrapEffect(
	Effect.gen(function* () {
		const url = Redacted.make(yield* Config.string("DATABASE_URL"));

		return MysqlClient.layer({ url });
	}),
);

export const ShardDatabaseLive = Layer.unwrapEffect(
	Effect.gen(function* () {
		const url = yield* Config.option(
			Config.redacted(Config.string("SHARD_DATABASE_URL")),
		);

		return yield* Option.match(url, {
			onNone: () =>
				Effect.gen(function* () {
					return Layer.succeed(
						MysqlClient.MysqlClient,
						yield* MysqlClient.MysqlClient,
					);
				}),
			onSome: (url) => Effect.succeed(MysqlClient.layer({ url })),
		});
	}),
);
