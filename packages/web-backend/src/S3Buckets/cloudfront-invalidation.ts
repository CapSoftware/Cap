import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { Config, Effect, Option } from "effect";
import { AwsCredentials } from "../Aws.ts";

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
				Effect.tryPromise(() =>
					client.send(
						new CreateInvalidationCommand({
							DistributionId: distributionId.value,
							InvalidationBatch: {
								CallerReference: crypto.randomUUID(),
								Paths: { Quantity: paths.length, Items: [...paths] },
							},
						}),
					),
				),
			(client) => Effect.sync(() => client.destroy()),
		);
		return true;
	});

export const shareLadderCdnPath = (ownerId: string, videoId: string) =>
	`/${ownerId}/${videoId}/.recording/outputs/ladder-*`;
