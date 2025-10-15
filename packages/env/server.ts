import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

const boolString = (_default = false) =>
	z
		.string()
		.optional()
		.default(_default ? "true" : "false")
		.transform((v) => v === "true")
		.pipe(z.boolean());

function createServerEnv() {
	return createEnv({
		server: {
			NODE_ENV: z.string(),
			DATABASE_URL: z.string(),
			WEB_URL: z.string(),
			DATABASE_MIGRATION_URL: z.string().optional(),
			DATABASE_ENCRYPTION_KEY: z.string().optional(),
			S3_PATH_STYLE: boolString(true),
			CAP_AWS_BUCKET: z.string(),
			CAP_AWS_REGION: z.string(),
			CAP_AWS_BUCKET_URL: z.string().optional(),
			CAP_AWS_ACCESS_KEY: z.string().optional(),
			CAP_AWS_SECRET_KEY: z.string().optional(),
			CAP_AWS_ENDPOINT: z.string().optional(),
			CAP_AWS_MEDIACONVERT_ROLE_ARN: z.string().optional(),
			CAP_CLOUDFRONT_DISTRIBUTION_ID: z.string().optional(),
			NEXTAUTH_SECRET: z.string(),
			NEXTAUTH_URL: z.string(),
			GOOGLE_CLIENT_ID: z.string().optional(),
			GOOGLE_CLIENT_SECRET: z.string().optional(),
			WORKOS_CLIENT_ID: z.string().optional(),
			WORKOS_API_KEY: z.string().optional(),
			DUB_API_KEY: z.string().optional(),
			RESEND_API_KEY: z.string().optional(),
			RESEND_FROM_DOMAIN: z.string().optional(),
			DEEPGRAM_API_KEY: z.string().optional(),
			NEXT_LOOPS_KEY: z.string().optional(),
			STRIPE_SECRET_KEY_TEST: z.string().optional(),
			STRIPE_SECRET_KEY_LIVE: z.string().optional(),
			STRIPE_WEBHOOK_SECRET_LIVE: z.string().optional(),
			STRIPE_WEBHOOK_SECRET_TEST: z.string().optional(),
			DISCORD_FEEDBACK_WEBHOOK_URL: z.string().optional(),
			OPENAI_API_KEY: z.string().optional(),
			GROQ_API_KEY: z.string().optional(),
			INTERCOM_SECRET: z.string().optional(),
			CAP_VIDEOS_DEFAULT_PUBLIC: boolString(true),
			CAP_ALLOWED_SIGNUP_DOMAINS: z.string().optional(),
			VERCEL_ENV: z
				.union([
					z.literal("production"),
					z.literal("preview"),
					z.literal("development"),
				])
				.optional(),
			VERCEL_TEAM_ID: z.string().optional(),
			VERCEL_PROJECT_ID: z.string().optional(),
			VERCEL_AUTH_TOKEN: z.string().optional(),
			VERCEL_URL_HOST: z.string().optional(),
			VERCEL_BRANCH_URL_HOST: z.string().optional(),
			VERCEL_PROJECT_PRODUCTION_URL_HOST: z.string().optional(),
			DOCKER_BUILD: z.string().optional(),
			POSTHOG_PERSONAL_API_KEY: z.string().optional(),
			CLOUDFRONT_KEYPAIR_ID: z.string().optional(),
			CLOUDFRONT_KEYPAIR_PRIVATE_KEY: z.string().optional(),
			S3_PUBLIC_ENDPOINT: z.string().optional(),
			S3_INTERNAL_ENDPOINT: z.string().optional(),
			VERCEL_AWS_ROLE_ARN: z.string().optional(),
			WORKFLOWS_RPC_URL: z.string().optional(),
			WORKFLOWS_RPC_SECRET: z.string(),
		},
		experimental__runtimeEnv: {
			...process.env,
			VERCEL_URL_HOST: process.env.VERCEL_URL,
			VERCEL_BRANCH_URL_HOST: process.env.VERCEL_BRANCH_URL,
			VERCEL_PROJECT_PRODUCTION_URL_HOST:
				process.env.VERCEL_PROJECT_PRODUCTION_URL,
		},
	});
}

let _cached: ReturnType<typeof createServerEnv> | undefined;
export const serverEnv = () => {
	if (_cached) return _cached;
	_cached = createServerEnv();
	return _cached;
};
