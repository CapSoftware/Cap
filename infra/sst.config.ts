/// <reference path="./.sst/platform/config.d.ts" />

const GITHUB_ORG = "CapSoftware";
const GITHUB_REPO = "Cap";
const GITHUB_APP_ID = "1196731";

const VERCEL_TEAM_SLUG = "mc-ilroy";
const VERCEL_TEAM_ID = "team_vbZRU7UW78rpKKIj4c9PfFAC";

const CLOUDFLARE_ACCOUNT_ID = "3de2dd633194481d80f68f55257bdbaa";
const AXIOM_API_TOKEN = "xaat-c0704be6-e942-4935-b068-3b491d7cc00f";
const AXIOM_DATASET = "cap-otel";

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
				aws: {
				},
				planetscale: true,
				awsx: "2.21.1",
			},
		};
	},
	async run() {
		const WEB_URLS: Record<string, string> = {
			production: "https://cap.so",
			staging: "https://staging.cap.so",
		};
		const webUrl = WEB_URLS[$app.stage];
		const secrets = Secrets();
		// const planetscale = Planetscale();

		const recordingsBucket = new aws.s3.BucketV2("RecordingsBucket");

		const vercelVariables = [
			{ key: "NEXT_PUBLIC_AXIOM_TOKEN", value: AXIOM_API_TOKEN },
			{ key: "NEXT_PUBLIC_AXIOM_DATASET", value: AXIOM_DATASET },
			{ key: "CAP_AWS_BUCKET", value: recordingsBucket.bucket },
			{ key: "NEXT_PUBLIC_CAP_AWS_BUCKET", value: recordingsBucket.bucket },
			{ key: "DATABASE_URL", value: secrets.DATABASE_URL_HTTP.value },
		];

		// new aws.s3.BucketAccelerateConfigurationV2("RecordingsBucketAcceleration", {
		// 	bucket: recordingsBucket.id,
		// 	status: "Enabled",
		// });

		// const cloudfrontDistribution = aws.cloudfront.getDistributionOutput({
		// 	id: "E36XSZEM0VIIYB",
		// });

		const vercelUser = new aws.iam.User("VercelUser", { forceDestroy: false });

		const vercelProject = vercel.getProjectOutput({ name: "cap-web" });

		if (webUrl) {
			vercelVariables.push(
				{ key: "WEB_URL", value: webUrl },
				{ key: "NEXT_PUBLIC_WEB_URL", value: webUrl },
				{ key: "NEXTAUTH_URL", value: webUrl },
			);
		}

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
				provider: await aws.iam
					.getOpenIdConnectProvider({ url: `https://${url}` })
					.catch(
						() =>
							new aws.iam.OpenIdConnectProvider(
								"VercelAWSOIDC",
								{ url: `https://${url}`, clientIdLists: [aud] },
								{ retainOnDelete: true },
							),
					),
			};
		})();

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
								[`${oidc.url}:sub`]: [
									`owner:${VERCEL_TEAM_SLUG}:project:*:environment:staging`,
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
									Resource: `${arn}`,
								},
							],
						}),
					),
				},
			],
		});

		const workflowCluster = await WorkflowCluster(recordingsBucket, secrets);

		if ($app.stage === "staging" || $app.stage === "production") {
			[
				...vercelVariables,
				{ key: "REMOTE_WORKFLOW_URL", value: workflowCluster.api.url },
				{ key: "VERCEL_AWS_ROLE_ARN", value: vercelAwsAccessRole.arn },
			].map(
				(v) =>
					new vercel.ProjectEnvironmentVariable(`VercelEnv${v.key}`, {
						...v,
						projectId: vercelProject.id,
						customEnvironmentIds:
							$app.stage === "staging"
								? ["env_CFbtmnpsI11e4o8X5UD8MZzxELQi"]
								: undefined,
						targets:
							$app.stage === "staging" ? undefined : ["preview", "production"],
					}),
			);
		}

		// DiscordBot();
	},
});

function Secrets() {
	return {
		DATABASE_URL_HTTP: new sst.Secret("DATABASE_URL_HTTP"),
		DATABASE_URL_MYSQL: new sst.Secret("DATABASE_URL_MYSQL"),
		CAP_AWS_ACCESS_KEY: new sst.Secret("CAP_AWS_ACCESS_KEY"),
		CAP_AWS_SECRET_KEY: new sst.Secret("CAP_AWS_SECRET_KEY"),
		GITHUB_PAT: new sst.Secret("GITHUB_PAT"),
	};
}

type Secrets = ReturnType<typeof Secrets>;

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

async function WorkflowCluster(bucket: aws.s3.BucketV2, secrets: Secrets) {
	const pulumi = await import("@pulumi/pulumi");

	const vpc = new sst.aws.Vpc("Vpc", {
		nat: "ec2",
	});
	const privateDnsNamespace = new aws.servicediscovery.PrivateDnsNamespace(
		"WorkflowClusterPrivateDnsNamespace",
		{
			name: "effect-cluster.private",
			description: "Private namespace for effect-cluster",
			vpc: vpc.id,
		},
	);

	function generateServiceHostname(serviceName: string) {
		return $interpolate`${serviceName}.${$app.stage}.${$app.name}.${privateDnsNamespace.name}`;
	}

	const securityGroup = new aws.ec2.SecurityGroup(
		"WorkflowClusterSecurityGroup",
		{ vpcId: vpc.id, description: "Security group for effect-cluster" },
	);
	new aws.vpc.SecurityGroupEgressRule("allow_all_traffic_ipv4", {
		securityGroupId: securityGroup.id,
		cidrIpv4: "0.0.0.0/0",
		ipProtocol: "-1",
	});
	// allow inbound from vpc
	new aws.vpc.SecurityGroupIngressRule("allow_inbound_from_vpc", {
		securityGroupId: securityGroup.id,
		cidrIpv4: vpc.nodes.vpc.cidrBlock,
		ipProtocol: "-1",
	});
	const cluster = new sst.aws.Cluster("EffectCluster", {
		vpc: {
			id: vpc.id,
			securityGroups: [securityGroup.id],
			containerSubnets: vpc.privateSubnets,
			loadBalancerSubnets: vpc.publicSubnets,
			cloudmapNamespaceId: privateDnsNamespace.id,
			cloudmapNamespaceName: privateDnsNamespace.name,
		},
		transform: {
			cluster: {
				settings: [{ name: "containerInsights", value: "enhanced" }],
			},
		},
	});

	const db = new sst.aws.Aurora('AuroraDB', {
		engine: "mysql",
		vpc,
		scaling: {
			min: "0.5 ACU",
			max: "4 ACU",
		}
	});

	const commonEnvironment = {
		CAP_AWS_REGION: bucket.region,
		CAP_AWS_BUCKET: bucket.bucket,
		DATABASE_URL: $interpolate`mysql://${db.username}:${db.password}@${db.host}:${db.port}/${db.database}`, // secrets.DATABASE_URL_MYSQL.value,
		CAP_AWS_ACCESS_KEY: secrets.CAP_AWS_ACCESS_KEY.value,
		CAP_AWS_SECRET_KEY: secrets.CAP_AWS_SECRET_KEY.value,
		AXIOM_API_TOKEN,
		AXIOM_DOMAIN: "api.axiom.co",
		AXIOM_DATASET,
	};

	const ghcrCredentialsSecret = new aws.secretsmanager.Secret(
		"GHCRCredentialsSecret",
	);

	new aws.secretsmanager.SecretVersion("GHCRCredentialsSecretVersion", {
		secretId: ghcrCredentialsSecret.id,
		secretString: secrets.GITHUB_PAT.value.apply((password) =>
			JSON.stringify({
				username: "brendonovich",
				password,
			}),
		),
	});

	const ghcrCredentialsTransform = {
		taskRole(args) {
			args.inlinePolicies = pulumi
				.all([args.inlinePolicies ?? [], ghcrCredentialsSecret.arn])
				.apply(([policies, arn]) => {
					policies.push({
						policy: JSON.stringify({
							Version: "2012-10-17",
							Statement: [
								{
									Effect: "Allow",
									Action: ["secretsmanager:GetSecretValue"],
									Resource: [arn],
								},
							],
						}),
					});
					return policies;
				});
		},
		taskDefinition(args) {
			args.containerDefinitions = pulumi
				.all([$jsonParse(args.containerDefinitions), ghcrCredentialsSecret.arn])
				.apply(([def, arn]) => {
					for (const container of def) {
						container.repositoryCredentials = { credentialsParameter: arn };
					}
					return JSON.stringify(def);
				});
		},
	} satisfies sst.aws.ServiceArgs["transform"];

	new sst.aws.Service("ShardManager", {
		cluster,
		architecture: "arm64",
		containers: [
			{
				name: "shard-manager",
				image: "ghcr.io/brendonovich/cap-web-cluster:latest",
				command: ["src/shard-manager.ts"],
				environment: {
					...commonEnvironment,
					SHARD_MANAGER_HOST: "0.0.0.0",
				},
			},
		],
		transform: ghcrCredentialsTransform,
	});

	const runner = new sst.aws.Service("Runner", {
		cluster,
		capacity: "spot",
		cpu: "0.25 vCPU",
		memory: "1 GB",
		architecture: "arm64",
		serviceRegistry: { port: 42169 },
		image: "ghcr.io/brendonovich/cap-web-cluster:latest",
		command: ["src/runner/index.ts"],
		health: {
			command: ["CMD", "deno", "run", "--allow-all", "src/health-check.ts"],
		},
		environment: {
			...commonEnvironment,
			SHARD_MANAGER_HOST: generateServiceHostname("ShardManager"),
			PORT: "42069",
			HEALTH_CHECK_PORT: "3000",
		},
		scaling: {
			min: 2,
			max: 16,
			cpuUtilization: 70,
			memoryUtilization: 70,
		},
		transform: {
			...ghcrCredentialsTransform,
			// Set a restart policy for all containers
			// Not provided by the SST configs
			taskDefinition: (args) => {
				// "containerDefinitions" is a JSON string, parse first
				let value = $jsonParse(args.containerDefinitions);

				// Update "portMappings"
				value = value.apply((containerDefinitions) => {
					for (const container of containerDefinitions) {
						container.restartPolicy = {
							enabled: true,
							restartAttemptPeriod: 60,
						};
					}
					return containerDefinitions;
				});

				// Convert back to JSON string
				args.containerDefinitions = $jsonStringify(value);

				ghcrCredentialsTransform.taskDefinition(args);
			},
		},
	});

	const api = new sst.aws.ApiGatewayV2("MyApi", {
		vpc,
	});
	api.routePrivate("$default", runner.nodes.cloudmapService.arn);

	return {
		api,
	};
}
