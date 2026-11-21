import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { Config, Effect, Option, Schedule } from "effect";
import { AwsCredentials } from "../Aws.ts";

// CloudFront allows 3,000 exact paths in progress at once, but only 15
// wildcard paths, so ladder purges name every file.
const PATHS_PER_INVALIDATION = 3000;

export const SHARE_LADDER_OUTPUT_FILES = [
	"master.m3u8",
	...["1080p", "720p", "360p", "audio"].flatMap((name) => [
		`${name}.m3u8`,
		`${name}.m4s`,
	]),
] as const;

export const shareLadderCdnPaths = (outputPrefix: string) =>
	SHARE_LADDER_OUTPUT_FILES.map((file) => `/${outputPrefix}${file}`);

export const invalidateCloudFrontPaths = (paths: readonly string[]) =>
	Effect.gen(function* () {
		if (paths.length === 0) return false;
		const distributionId = yield* Config.option(
			Config.string("CAP_CLOUDFRONT_DISTRIBUTION_ID"),
		);
		if (Option.isNone(distributionId)) return false;
		const region = yield* Config.string("CAP_AWS_REGION").pipe(
			Config.withDefault("us-east-1"),
		);
		const { credentials } = yield* AwsCredentials;
		yield* Effect.acquireUseRelease(
			Effect.sync(() => new CloudFrontClient({ region, credentials })),
			(client) =>
				Effect.forEach(
					Array.from(
						{ length: Math.ceil(paths.length / PATHS_PER_INVALIDATION) },
						(_, index) =>
							paths.slice(
								index * PATHS_PER_INVALIDATION,
								(index + 1) * PATHS_PER_INVALIDATION,
							),
					),
					(batch) =>
						Effect.tryPromise(() =>
							client.send(
								new CreateInvalidationCommand({
									DistributionId: distributionId.value,
									InvalidationBatch: {
										CallerReference: crypto.randomUUID(),
										Paths: { Quantity: batch.length, Items: [...batch] },
									},
								}),
							),
						).pipe(
							Effect.retry(
								Schedule.exponential("2 seconds").pipe(
									Schedule.intersect(Schedule.recurs(4)),
								),
							),
						),
					{ discard: true },
				),
			(client) => Effect.sync(() => client.destroy()),
		);
		return true;
	});
