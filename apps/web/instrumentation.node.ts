// This file is used to run database migrations in the docker builds or other self hosting environments.
// It is not suitable (a.k.a DEADLY) for serverless environments where the server will be restarted on each request.
//

import {
	BucketAlreadyExists,
	BucketAlreadyOwnedByYou,
	CreateBucketCommand,
	DeleteBucketPolicyCommand,
	GetBucketPolicyCommand,
	PutBucketPolicyCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { migrateDb } from "@cap/database/migrate";
import { buildEnv, serverEnv } from "@cap/env";

export async function register() {
	if (process.env.NEXT_PUBLIC_IS_CAP) return;

	// Exit, not throw: Next.js catches a throwing register() and serves 500s.
	try {
		serverEnv();
	} catch {
		console.error("🚨 Environment validation failed, exiting");
		process.exit(1);
	}

	console.log("Waiting 5 seconds to run migrations");
	// Function to trigger migrations with retry logic
	const triggerMigrations = async (retryCount = 0, maxRetries = 3) => {
		try {
			await runMigrations();
		} catch (error) {
			console.error(
				`🚨 Error triggering migrations (attempt ${retryCount + 1}):`,
				error,
			);
			if (retryCount < maxRetries - 1) {
				console.log(
					`🔄 Retrying in 5 seconds... (${retryCount + 1}/${maxRetries})`,
				);
				setTimeout(() => triggerMigrations(retryCount + 1, maxRetries), 5000);
			} else {
				console.error(`🚨 All ${maxRetries} migration attempts failed.`);
				process.exit(1); // Exit with error code if all attempts fail
			}
		}
	};
	// Add a timeout to trigger migrations after 5 seconds on server start
	setTimeout(() => triggerMigrations(), 5000);
	setTimeout(() => createS3Bucket(), 5000);
}

export function isLegacyCapPublicPolicyStatement(
	statement: unknown,
	bucket: string,
): boolean {
	if (!statement || typeof statement !== "object") return false;
	const s = statement as Record<string, unknown>;
	if (s.Effect !== "Allow") return false;
	if (s.Condition !== undefined && s.Condition !== null) return false;

	const isWildcardPrincipal =
		s.Principal === "*" ||
		(typeof s.Principal === "object" &&
			s.Principal !== null &&
			"AWS" in s.Principal &&
			(s.Principal as { AWS: unknown }).AWS === "*");

	if (!isWildcardPrincipal) return false;

	const actions = Array.isArray(s.Action)
		? s.Action
		: typeof s.Action === "string"
			? [s.Action]
			: [];
	const isOnlyGetObject = actions.length === 1 && actions[0] === "s3:GetObject";
	if (!isOnlyGetObject) return false;

	const resources = Array.isArray(s.Resource)
		? s.Resource
		: typeof s.Resource === "string"
			? [s.Resource]
			: [];
	const expectedArn = `arn:aws:s3:::${bucket}/*`;
	return resources.length === 1 && resources[0] === expectedArn;
}

export async function cleanupLegacyBucketPolicy(
	s3Client: S3Client,
	bucket: string,
) {
	try {
		const policyOutput = await s3Client.send(
			new GetBucketPolicyCommand({ Bucket: bucket }),
		);
		if (!policyOutput.Policy) return;

		const parsed = JSON.parse(policyOutput.Policy) as {
			Statement?: unknown;
			[key: string]: unknown;
		};
		const rawStatements = Array.isArray(parsed.Statement)
			? parsed.Statement
			: parsed.Statement
				? [parsed.Statement]
				: [];

		const legacyFound = rawStatements.some((stmt) =>
			isLegacyCapPublicPolicyStatement(stmt, bucket),
		);
		if (!legacyFound) return;

		const remainingStatements = rawStatements.filter(
			(stmt) => !isLegacyCapPublicPolicyStatement(stmt, bucket),
		);

		if (remainingStatements.length === 0) {
			await s3Client.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
			console.log("Removed legacy public S3 bucket policy");
		} else {
			await s3Client.send(
				new PutBucketPolicyCommand({
					Bucket: bucket,
					Policy: JSON.stringify({
						...parsed,
						Statement: remainingStatements,
					}),
				}),
			);
			console.log("Removed legacy public read statement from S3 bucket policy");
		}
	} catch (error: unknown) {
		const name =
			typeof error === "object" && error !== null && "name" in error
				? String((error as { name: unknown }).name)
				: "";
		if (
			name === "NoSuchBucketPolicy" ||
			name === "MethodNotAllowed" ||
			name === "NotImplemented" ||
			name === "UnsupportedOperation"
		) {
			return;
		}
		console.warn("Could not inspect S3 bucket policy:", error);
	}
}

export async function createS3Bucket(client?: S3Client) {
	const bucket = serverEnv().CAP_AWS_BUCKET;
	const s3Client =
		client ??
		new S3Client({
			endpoint: serverEnv().S3_INTERNAL_ENDPOINT,
			region: serverEnv().CAP_AWS_REGION,
			credentials: {
				accessKeyId: serverEnv().CAP_AWS_ACCESS_KEY ?? "",
				secretAccessKey: serverEnv().CAP_AWS_SECRET_KEY ?? "",
			},
			forcePathStyle: serverEnv().S3_PATH_STYLE,
		});

	try {
		await s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
		console.log("Created S3 bucket");
	} catch (error: unknown) {
		const isExistingBucketError =
			error instanceof BucketAlreadyOwnedByYou ||
			error instanceof BucketAlreadyExists ||
			(typeof error === "object" &&
				error !== null &&
				"name" in error &&
				(error.name === "BucketAlreadyOwnedByYou" ||
					error.name === "BucketAlreadyExists"));

		if (isExistingBucketError) {
			console.log("Found existing S3 bucket");
		} else {
			console.error("🚨 Failed to initialize S3 bucket:", error);
			return;
		}
	}

	await cleanupLegacyBucketPolicy(s3Client, bucket);
}

async function runMigrations() {
	const isDockerBuild = buildEnv.NEXT_PUBLIC_DOCKER_BUILD === "true";
	if (isDockerBuild) {
		try {
			console.log("🔍 DB migrations triggered");
			console.log("💿 Running DB migrations...");

			await migrateDb();

			console.log("💿 Migrations run successfully!");
		} catch (error) {
			console.error("🚨 MIGRATION_FAILED", { error });
			throw error;
		}
	}
}
