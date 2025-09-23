/// <reference path="./.sst/platform/config.d.ts" />

const GITHUB_ORG = "CapSoftware";
const GITHUB_REPO = "Cap";
const GITHUB_APP_ID = "1196731";

const VERCEL_TEAM_SLUG = "mc-ilroy";
const VERCEL_TEAM_ID = "team_vbZRU7UW78rpKKIj4c9PfFAC";

const CLOUDFLARE_ACCOUNT_ID = "3de2dd633194481d80f68f55257bdbaa";

export default $config({
	app(input) {
		return {
			name: "cap",
			removal: input?.stage === "production" ? "retain" : "remove",
			protect: ["production"].includes(input?.stage),
			home: "aws",
			providers: {
				vercel: {
					team: VERCEL_TEAM_ID,
					version: "3.15.1",
				},
				github: {
					owner: GITHUB_ORG,
				},
				cloudflare: true,
			},
		};
	},
	async run() {
		const WEB_URLS: Record<string, string> = {
			production: "https://cap.so",
			staging: "https://cap-staging.brendonovich.dev",
		};
		const webUrl = WEB_URLS[$app.stage];
		// const planetscale = Planetscale();

		const recordingsBucket = new aws.s3.BucketV2("RecordingsBucket");

		new aws.s3.BucketAccelerateConfigurationV2("RecordingsBucketAcceleration", {
			bucket: recordingsBucket.id,
			status: "Enabled",
		});

		// const cloudfrontDistribution = aws.cloudfront.getDistributionOutput({
		// 	id: "E36XSZEM0VIIYB",
		// });

		const vercelUser = new aws.iam.User("VercelUser", { forceDestroy: false });

		const vercelProject = vercel.getProjectOutput({ name: "cap-web" });

		function vercelEnvVar(
			name: string,
			args: Omit<
				vercel.ProjectEnvironmentVariableArgs,
				"projectId" | "customEnvironmentIds" | "targets"
			>,
		) {
			new vercel.ProjectEnvironmentVariable(name, {
				...args,
				projectId: vercelProject.id,
				customEnvironmentIds:
					$app.stage === "staging"
						? ["env_CFbtmnpsI11e4o8X5UD8MZzxELQi"]
						: undefined,
				targets:
					$app.stage === "staging" ? undefined : ["preview", "production"],
			});
		}

		vercelEnvVar("VercelDatabaseURLEnv", {
			key: "DATABASE_URL",
			value: new sst.Secret("DATABASE_URL").value,
		});

		if (webUrl) {
			vercelEnvVar("VercelWebURLEnv", {
				key: "WEB_URL",
				value: webUrl,
			});
			vercelEnvVar("VercelNextPublicWebURLEnv", {
				key: "NEXT_PUBLIC_WEB_URL",
				value: webUrl,
			});
			vercelEnvVar("VercelNextAuthURLEnv", {
				key: "NEXTAUTH_URL",
				value: webUrl,
			});
		}

		// vercelEnvVar("VercelCloudfrontEnv", {
		// 	key: "CAP_CLOUDFRONT_DISTRIBUTION_ID",
		// 	value: cloudfrontDistribution.id,
		// });

		vercelEnvVar("VercelAWSBucketEnv", {
			key: "CAP_AWS_BUCKET",
			value: recordingsBucket.bucket,
		});

		vercelEnvVar("VercelNextPublicAWSBucketEnv", {
			key: "NEXT_PUBLIC_CAP_AWS_BUCKET",
			value: recordingsBucket.bucket,
		});

		const vercelOidc = aws.iam.getOpenIdConnectProviderOutput({
			url: `https://oidc.vercel.com/${VERCEL_TEAM_SLUG}`,
		});

		const awsAccount = aws.getCallerIdentityOutput();

		const vercelAwsAccessRole = new aws.iam.Role("VercelAWSAccessRole", {
			assumeRolePolicy: {
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Principal: {
							Federated: $interpolate`arn:aws:iam::${awsAccount.id}:oidc-provider/oidc.vercel.com/${VERCEL_TEAM_SLUG}`,
						},
						Action: "sts:AssumeRoleWithWebIdentity",
						Condition: {
							StringEquals: {
								[`oidc.vercel.com/${VERCEL_TEAM_SLUG}:aud`]:
									vercelOidc.clientIdLists[0],
								[`oidc.vercel.com/${VERCEL_TEAM_SLUG}:sub`]: [
									`owner:${VERCEL_TEAM_SLUG}:project:${vercelProject.name}:environment:staging`,
								],
							},
						},
					},
				],
			},
			inlinePolicies: [
				{
					name: "VercelAWSAccessPolicy",
					policy: recordingsBucket.arn.apply((arn) =>
						JSON.stringify({
							Version: "2012-10-17",
							Statement: [
								{
									Effect: "Allow",
									Action: ["s3:*"],
									Resource: `${arn}/*`,
								},
								{
									Effect: "Allow",
									Action: ["s3:*"],
									Resource: arn,
								},
							],
						} satisfies aws.iam.PolicyDocument),
					),
				},
			],
		});

		vercelEnvVar("VercelAWSAccessRoleArn", {
			key: "VERCEL_AWS_ROLE_ARN",
			value: vercelAwsAccessRole.arn,
		});

		// DiscordBot();
	},
});

// function Planetscale() {
// 	const org = planetscale.getOrganizationOutput({ name: "cap" });
// 	const db = planetscale.getDatabaseOutput({
// 		name: "cap-production",
// 		organization: org.name,
// 	});
// 	const branch = planetscale.getBranchOutput({
// 		name: $app.stage === "production" ? "main" : "staging",
// 		database: db.name,
// 		organization: org.name,
// 	});

// 	return { org, db, branch };
// }

function DiscordBot() {
	new sst.cloudflare.Worker("DiscordBotScript", {
		handler: "../apps/discord-bot/src/index.ts",
		transform: {
			worker: (args) => {
				args.name = "cap-discord-bot";
				args.kvNamespaceBindings = [
					{
						name: "release_discord_interactions",
						namespaceId: "846b080b86914e2ba666d35acee35c9a",
					},
				];
				args.secretTextBindings = [
					{
						name: "DISCORD_BOT_TOKEN",
						text: new sst.Secret("DISCORD_BOT_TOKEN").value,
					},
					{
						name: "GITHUB_APP_PRIVATE_KEY",
						text: new sst.Secret("GITHUB_APP_PRIVATE_KEY").value,
					},
				];
			},
		},
	});
}
