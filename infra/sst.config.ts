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
				},
				github: {
					owner: GITHUB_ORG,
				},
				cloudflare: true,
			},
		};
	},
	async run() {
		const recordingsBucket = new aws.s3.BucketV2("RecordingsBucket");

		new aws.s3.BucketAccelerateConfigurationV2("RecordingsBucketAcceleration", {
			bucket: recordingsBucket.id,
			status: "Enabled",
		});

		const cloudfrontDistribution = new aws.cloudfront.Distribution(
			"CapSoCloudfrontDistribution",
			{
				aliases: ["v.cap.so"],
				defaultCacheBehavior: {
					cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
					compress: true,
					allowedMethods: ["GET", "HEAD", "OPTIONS"],
					cachedMethods: ["GET", "HEAD", "OPTIONS"],
					targetOriginId: recordingsBucket.bucketRegionalDomainName,
					viewerProtocolPolicy: "redirect-to-https",
					originRequestPolicyId: "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf",
					responseHeadersPolicyId: "07e54f95-0547-4c80-a967-95a236bd9b94",
				},
				isIpv6Enabled: true,
				enabled: true,
				restrictions: { geoRestriction: { restrictionType: "none" } },
				viewerCertificate: {
					acmCertificateArn:
						"arn:aws:acm:us-east-1:211125561119:certificate/9165b27f-0f9e-497b-9ff5-5b6a885c5eed",
					minimumProtocolVersion: "TLSv1.2_2021",
					sslSupportMethod: "sni-only",
				},
				webAclId:
					"arn:aws:wafv2:us-east-1:211125561119:global/webacl/CreatedByCloudFront-4f671e75-3f7c-45dd-9283-979b497f5af7/0e2022cf-dd4a-4427-908f-f7e88530894b",
				orderedCacheBehaviors: [
					{
						allowedMethods: ["GET", "HEAD", "OPTIONS"],
						cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
						cachedMethods: ["GET", "HEAD", "OPTIONS"],
						compress: true,
						originRequestPolicyId: "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf",
						pathPattern: "_recording",
						realtimeLogConfigArn: "",
						responseHeadersPolicyId: "5cc3b908-e619-4b99-88e5-2cf7f45965bd",
						targetOriginId: "cap.so",
						viewerProtocolPolicy: "redirect-to-https",
					},
					{
						allowedMethods: ["GET", "HEAD", "OPTIONS"],
						cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
						cachedMethods: ["GET", "HEAD", "OPTIONS"],
						compress: true,
						originRequestPolicyId: "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf",
						pathPattern: "/dev/*",
						responseHeadersPolicyId: "07e54f95-0547-4c80-a967-95a236bd9b94",
						targetOriginId: "capso-dev.s3.us-east-1.amazonaws.com",
						viewerProtocolPolicy: "redirect-to-https",
					},
				],
				origins: [
					{
						connectionAttempts: 3,
						connectionTimeout: 10,
						customOriginConfig: {
							httpPort: 80,
							httpsPort: 443,
							originKeepaliveTimeout: 5,
							originProtocolPolicy: "https-only",
							originReadTimeout: 30,
							originSslProtocols: ["TLSv1.2"],
						},
						domainName: "cap.link",
						originId: "cap.link",
						originPath: "",
						originShield: {
							enabled: true,
							originShieldRegion: "us-east-1",
						},
					},
					{
						customOriginConfig: {
							httpPort: 80,
							httpsPort: 443,
							originKeepaliveTimeout: 5,
							originProtocolPolicy: "https-only",
							originReadTimeout: 30,
							originSslProtocols: ["TLSv1.2"],
						},
						domainName: "cap.so",
						originId: "cap.so",
						originShield: {
							enabled: true,
							originShieldRegion: "us-east-1",
						},
					},
					{
						domainName: "capso-dev.s3.us-east-1.amazonaws.com",
						originAccessControlId: "E2CB8AE0M9IHH8",
						originId: "capso-dev.s3.us-east-1.amazonaws.com",
					},
					{
						domainName: recordingsBucket.bucketRegionalDomainName,
						originAccessControlId: "E26H3W7A2N2HP3",
						originId: recordingsBucket.bucketRegionalDomainName,
						originShield: {
							enabled: true,
							originShieldRegion: recordingsBucket.region,
						},
					},
				],
			},
		);

		const vercelUser = new aws.iam.User(
			"VercelUser",
			{
				name: "uploader",
				forceDestroy: false,
			},
			{ import: "uploader" },
		);

		const vercelAccessKey = new aws.iam.AccessKey("VercelS3AccessKey", {
			user: vercelUser.name,
		});

		const vercelProject = new vercel.Project("VercelProject", {
			buildCommand: "cd ../.. && pnpm turbo run build --filter=@cap/web",
			installCommand: "pnpm install --no-frozen-lockfile",
			framework: "nextjs",
			gitRepository: {
				productionBranch: "main",
				repo: `${GITHUB_ORG}/${GITHUB_REPO}`,
				type: "github",
			},
			protectionBypassForAutomation: true,
			rootDirectory: "apps/web",
		});

		new vercel.ProjectEnvironmentVariable("VercelS3AccessEnv", {
			key: "CAP_AWS_ACCESS_KEY",
			value: vercelAccessKey.id,
			projectId: vercelProject.id,
			targets: ["production", "preview", "development"],
		});

		new vercel.ProjectEnvironmentVariable("VercelCloudfrontEnv", {
			key: "CAP_CLOUDFRONT_DISTRIBUTION_ID",
			value: cloudfrontDistribution.id,
			projectId: vercelProject.id,
			targets: ["production", "preview", "development"],
		});

		new aws.iam.OpenIdConnectProvider("VercelOIDCProvider", {
			url: "https://oidc.vercel.com",
			clientIdLists: [`https://vercel.com/${VERCEL_TEAM_ID}`],
		});

		const awsAccount = await aws.getCallerIdentity();

		const vercelAwsAccessRole = new aws.iam.Role("VercelAWSAccessRole", {
			name: "VercelOIDCRole",
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
									`owner:${VERCEL_TEAM_SLUG}:project:${vercelProject.name}:environment:preview`,
									`owner:${VERCEL_TEAM_SLUG}:project:${vercelProject.name}:environment:production`,
								],
							},
						},
					},
				],
			},
		});

		new vercel.ProjectEnvironmentVariable("VercelAWSAccessRoleArn", {
			key: "AWS_ROLE_ARN",
			value: vercelAwsAccessRole.arn,
			projectId: vercelProject.id,
			targets: ["production", "preview"],
		});

		DiscordBot();
	},
});

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
