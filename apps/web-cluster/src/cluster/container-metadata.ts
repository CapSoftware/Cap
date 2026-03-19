import { Config, Data, Effect, Option } from "effect";

export class FetchIpError extends Data.TaggedError("FetchIpError")<{}> {}

class EcsContainerMetadata extends Effect.Service<EcsContainerMetadata>()(
	"EcsContainerMetadata",
	{
		effect: Effect.gen(function* () {
			return {
				metadataUri: yield* Config.option(
					Config.string("ECS_CONTAINER_METADATA_URI_V4"),
				),
			};
		}),
	},
) {}

export const privateIp = EcsContainerMetadata.pipe(
	Effect.flatMap(({ metadataUri }) =>
		Option.match(metadataUri, {
			onNone: () => Effect.succeed("0.0.0.0"),
			onSome: (uri) =>
				Effect.tryPromise({
					try: async () => {
						const response = await fetch(`${uri}/task`);
						const data = await response.json();
						return data.Containers[0].Networks[0].IPv4Addresses[0] as string;
					},
					catch: (error) => {
						console.error("error", error);
						return new FetchIpError();
					},
				}),
		}),
	),
);

export class ContainerMetadata extends Effect.Service<ContainerMetadata>()(
	"ContainerMetadata",
	{
		effect: Effect.gen(function* () {
			const containerMetadata = yield* EcsContainerMetadata;
			const metadataUri = containerMetadata.metadataUri;
			const ipAddress = yield* Option.match(metadataUri, {
				onNone: () => Effect.succeed("0.0.0.0"),
				onSome: (uri) =>
					Effect.tryPromise({
						try: async () => {
							const response = await fetch(`${uri}/task`);
							const data = await response.json();
							return data.Containers[0].Networks[0].IPv4Addresses[0] as string;
						},
						catch: (error) => {
							console.error("error", error);
							return new FetchIpError();
						},
					}),
			});

			const port = yield* Config.number("PORT").pipe(Config.withDefault(42069));

			return { ipAddress, port };
		}),
		dependencies: [EcsContainerMetadata.Default],
	},
) {}
