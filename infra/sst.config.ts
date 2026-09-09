/// <reference path="./.sst/platform/config.d.ts" />

const GITHUB_ORG = "CapSoftware";
const _GITHUB_REPO = "Cap";
const _GITHUB_APP_ID = "1196731";

const VERCEL_PROJECT_NAME = "cap-web";
const VERCEL_TEAM_SLUG = "mc-ilroy";
const VERCEL_TEAM_ID = "team_vbZRU7UW78rpKKIj4c9PfFAC";

const _CLOUDFLARE_ACCOUNT_ID = "3de2dd633194481d80f68f55257bdbaa";
const AXIOM_API_TOKEN = "xaat-c0704be6-e942-4935-b068-3b491d7cc00f";
const AXIOM_DATASET = "cap-otel";

const parsedStage = () => {
	if ($app.stage === "staging") return { variant: "staging" } as const;
	if ($app.stage === "production") return { variant: "production" } as const;
	if ($app.stage.startsWith("git-branch-"))
		return {
			variant: "git-branch",
			branch: $app.stage.slice("git-branch-".length),
		} as const;
	throw new Error("Unsupported stage");
};

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
				aws: {},
				planetscale: true,
			},
		};
	},
	async run() {
		const stage = parsedStage();
		const WEB_URLS: Record<string, string> = {
			production: "https://cap.so",
			staging: "https://staging.cap.so",
		};
		const webUrl =
			WEB_URLS[stage.variant] ??
			`https://${VERCEL_PROJECT_NAME}-git-${stage.branch}-${VERCEL_TEAM_SLUG}.vercel.app`;
		const secrets = Secrets();
		// const planetscale = Planetscale();

		const recordingsBucket = new aws.s3.BucketV2(
			"RecordingsBucket",
			{},
			{ retainOnDelete: true },
		);

		new aws.s3.BucketCorsConfigurationV2("RecordingsBucketCors", {
			bucket: recordingsBucket.bucket,
			corsRules: [
				{
					allowedHeaders: ["*"],
					allowedMethods: ["GET", "POST"],
					allowedOrigins:
						stage.variant === "production"
							? [
									"https://cap.so",
									"https://cap.link",
									"https://v.cap.so",
									"https://dyk2p776s2gx5.cloudfront.net",
								]
							: ["http://localhost:*", "https://*.vercel.app", webUrl],
					exposeHeaders: [],
				},
			],
		});

		const vercelVariables = [
			{ key: "NEXT_PUBLIC_AXIOM_TOKEN", value: AXIOM_API_TOKEN },
			{ key: "NEXT_PUBLIC_AXIOM_DATASET", value: AXIOM_DATASET },
			{ key: "CAP_AWS_BUCKET", value: recordingsBucket.bucket },
			{ key: "DATABASE_URL", value: secrets.DATABASE_URL_MYSQL.value },
		];

		new aws.s3.BucketAccelerateConfigurationV2("RecordingsBucketAcceleration", {
			bucket: recordingsBucket.id,
			status: "Enabled",
		});

		const cloudfrontDistribution =
			stage.variant === "production"
				? aws.cloudfront.getDistributionOutput({ id: "E36XSZEM0VIIYB" })
				: null;

		const _vercelUser = new aws.iam.User("VercelUser", { forceDestroy: false });

		const vercelProject = vercel.getProjectOutput({
			name: VERCEL_PROJECT_NAME,
		});

		if (webUrl)
			vercelVariables.push(
				{ key: "WEB_URL", value: webUrl },
				{ key: "NEXT_PUBLIC_WEB_URL", value: webUrl },
				{ key: "NEXTAUTH_URL", value: webUrl },
			);

		// vercelEnvVar("VercelCloudfrontEnv", {
		// 	key: "CAP_CLOUDFRONT_DISTRIBUTION_ID",
		// 	value: cloudfrontDistribution.id,
		// });

		const awsAccount = aws.getCallerIdentityOutput();

		const oidc = await (async () => {
			const aud = `https://vercel.com/${VERCEL_TEAM_SLUG}`;
			const url = `oidc.vercel.com/${VERCEL_TEAM_SLUG}`;
			return {
				aud,
				url,
				provider: aws.iam.getOpenIdConnectProviderOutput({
					url: `https://${url}`,
				}),
			};
		})();

		const oidcSub = (environment: "production" | "preview" | "staging") =>
			`owner:${VERCEL_TEAM_SLUG}:project:${VERCEL_PROJECT_NAME}:environment:${environment}`;
		const vercelAwsAccessRole = new aws.iam.Role("VercelAWSAccessRole", {
			assumeRolePolicy: {
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Principal: {
							Federated: $interpolate`arn:aws:iam::${awsAccount.id}:oidc-provider/${oidc.url}`,
						},
						Action: "sts:AssumeRoleWithWebIdentity",
						Condition: {
							StringEquals: {
								[`${oidc.url}:aud`]: oidc.aud,
							},
							StringLike: {
								[`${oidc.url}:sub`]:
									stage.variant === "production"
										? [oidcSub("production")]
										: [oidcSub("preview"), oidcSub("staging")],
							},
						},
					},
				],
			},
			inlinePolicies: [
				{
					name: "VercelAWSAccessPolicy",
					policy: $resolve([
						recordingsBucket.arn,
						cloudfrontDistribution?.arn,
					] as const).apply(([bucketArn, cloudfrontArn]) =>
						JSON.stringify({
							Version: "2012-10-17",
							Statement: [
								{
									Effect: "Allow",
									Action: ["s3:*"],
									Resource: `${bucketArn}/*`,
								},
								{
									Effect: "Allow",
									Action: ["s3:*"],
									Resource: bucketArn,
								},
								cloudfrontArn && {
									Effect: "Allow",
									Action: ["cloudfront:CreateInvalidation"],
									Resource: cloudfrontArn,
								},
							].filter(Boolean),
						}),
					),
				},
			],
		});

		[
			...vercelVariables,
			{ key: "VERCEL_AWS_ROLE_ARN", value: vercelAwsAccessRole.arn },
		]
			.filter(Boolean)
			.forEach((_v) => {
				const v = _v as NonNullable<typeof _v>;

				new vercel.ProjectEnvironmentVariable(
					`VercelEnv${v.key}`,
					{
						...v,
						projectId: vercelProject.id,
						customEnvironmentIds:
							stage.variant === "staging"
								? ["env_CFbtmnpsI11e4o8X5UD8MZzxELQi"]
								: undefined,
						targets:
							stage.variant === "production"
								? ["production"]
								: stage.variant === "staging"
									? ["development", "preview"]
									: stage.variant === "git-branch"
										? ["preview"]
										: undefined,
						gitBranch:
							stage.variant === "git-branch" ? stage.branch : undefined,
						comment:
							"This var is being managed by SST, do not edit or delete it via the Vercel dashboard",
					},
					{ deleteBeforeReplace: true },
				);
			});

		// DiscordBot();
	},
});

function Secrets() {
	return {
		DATABASE_URL_MYSQL: new sst.Secret("DATABASE_URL_MYSQL"),
	};
}

// function DiscordBot() {
// 	new sst.cloudflare.Worker("DiscordBotScript", {
// 		handler: "../apps/discord-bot/src/index.ts",
// 		transform: {
// 			worker: (args) => {
// 				args.name = "cap-discord-bot";
// 				args.kvNamespaceBindings = [
// 					{
// 						name: "release_discord_interactions",
// 						namespaceId: "846b080b86914e2ba666d35acee35c9a",
// 					},
// 				];
// 				args.secretTextBindings = [
// 					{
// 						name: "DISCORD_BOT_TOKEN",
// 						text: new sst.Secret("DISCORD_BOT_TOKEN").value,
// 					},
// 					{
// 						name: "GITHUB_APP_PRIVATE_KEY",
// 						text: new sst.Secret("GITHUB_APP_PRIVATE_KEY").value,
// 					},
// 				];
// 			},
// 		},
// 	});
// }
