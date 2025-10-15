import { fromContainerMetadata, fromSSO } from "@aws-sdk/credential-providers";
import type {
	AwsCredentialIdentity,
	AwsCredentialIdentityProvider,
} from "@smithy/types";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { Config, Effect, Option } from "effect";

export class AwsCredentials extends Effect.Service<AwsCredentials>()(
	"AwsCredentials",
	{
		effect: Effect.gen(function* () {
			const accessKeys = yield* Config.option(
				Config.all([
					Config.string("CAP_AWS_ACCESS_KEY"),
					Config.string("CAP_AWS_SECRET_KEY"),
				]),
			);
			const vercelAwsRole = yield* Config.option(
				Config.string("VERCEL_AWS_ROLE_ARN"),
			);

			const credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider =
				yield* Effect.gen(function* () {
					if (Option.isSome(vercelAwsRole)) {
						yield* Effect.log("Using VERCEL_AWS_ROLE_ARN");
						return awsCredentialsProvider({ roleArn: vercelAwsRole.value });
					}

					if (Option.isSome(accessKeys)) {
						const [accessKeyId, secretAccessKey] = accessKeys.value;
						yield* Effect.log(
							"Using CAP_AWS_ACCESS_KEY and CAP_AWS_SECRET_KEY",
						);
						return { accessKeyId, secretAccessKey };
					}

					if (process.env.NODE_ENV === "development") {
						yield* Effect.log("Using AWS_DEFAULT_PROFILE");
						return fromSSO({ profile: process.env.AWS_DEFAULT_PROFILE });
					}

					yield* Effect.log("Falling back to ECS metadata");
					return fromContainerMetadata();
				});

			return { credentials };
		}),
	},
) {}
