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

		const vercelAccessKey = new aws.iam.AccessKey("VercelS3AccessKey", {
			user: vercelUser.name,
		});

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

		vercelEnvVar("VercelS3AccessEnv", {
			key: "CAP_AWS_ACCESS_KEY",
			value: vercelAccessKey.id,
		});

		// vercelEnvVar("VercelCloudfrontEnv", {
		// 	key: "CAP_CLOUDFRONT_DISTRIBUTION_ID",
		// 	value: cloudfrontDistribution.id,
		// });

		const vercelOidc = aws.iam.getOpenIdConnectProviderOutput({
			url: "https://oidc.vercel.com",
		});

		const awsAccount = await aws.getCallerIdentity();

		const vercelAwsAccessRole = new aws.iam.Role("VercelAWSAccessRole", {
			assumeRolePolicy: {
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Principal: {
							Federated: `arn:aws:iam::${awsAccount.id}:oidc-provider/oidc.vercel.com/${VERCEL_TEAM_SLUG}`,
						},
						Action: "sts:AssumeRoleWithWebIdentity",
						Condition: {
							StringEquals: {
								[`oidc.vercel.com/${VERCEL_TEAM_SLUG}:aud`]: `https://vercel.com/${VERCEL_TEAM_SLUG}`,
							},
							StringLike: {
								[`oidc.vercel.com/${VERCEL_TEAM_SLUG}:sub`]: [
									`owner:${VERCEL_TEAM_SLUG}:project:${vercelProject.name}:environment:${$app.stage}`,
								],
							},
						},
					},
				],
			},
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
