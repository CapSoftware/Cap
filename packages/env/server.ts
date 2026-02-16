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
		skipValidation: true,
		server: {
			/// General configuration
			DATABASE_URL: z.string().describe("MySQL database URL"),
			WEB_URL: z
				.string()
				.describe("Public URL of the server eg. https://cap.so"),
			NEXTAUTH_SECRET: z.string().describe("32 byte base64 string"),
			NEXTAUTH_URL: z.string().describe("Should be the same as WEB_URL"),
			DATABASE_ENCRYPTION_KEY: z
				.string()
				.optional()
				.describe(
					"32 byte hex string for encrypting values like AWS access keys",
				),

			// Cap uses Resend for email sending, including sending login code emails
			RESEND_API_KEY: z.string().optional(),
			RESEND_FROM_DOMAIN: z.string().optional(),

			/// S3 configuration
			// Though they are prefixed with `CAP_AWS`, these don't have to be
			// for AWS, and can instead be for any S3-compatible service
			CAP_AWS_BUCKET: z.string(),
			CAP_AWS_REGION: z.string(),
			CAP_AWS_ACCESS_KEY: z.string().optional(),
			CAP_AWS_SECRET_KEY: z.string().optional(),
			S3_PUBLIC_ENDPOINT: z
				.string()
				.optional()
				.describe("Public endpoint for accessing S3"),
			S3_INTERNAL_ENDPOINT: z
				.string()
				.optional()
				.describe(
					"Internal endpoint for accessing S3. This is useful if accessing S3 over public internet is more expensive than via your hosting environment's local network.",
				),
			S3_PATH_STYLE: boolString(true).describe(
				"Whether the bucket should be accessed using path-style URLs (common for non-AWS providers, eg. '/{bucket}/{key}') or virtual-hosted-style URLs (eg. '{bucket}.s3.amazonaws.com/{key}').",
			),

			/// CloudFront configuration
			// Configure these if you'd like to serve assets from the default bucket via CloudFront
			// In this case, CAP_AWS_BUCKET_URL should be your CloudFront distribution's URL
			CAP_AWS_BUCKET_URL: z
				.string()
				.optional()
				.describe("Public URL of the S3 bucket"),
			CAP_CLOUDFRONT_DISTRIBUTION_ID: z.string().optional(),
			CLOUDFRONT_KEYPAIR_ID: z.string().optional(),
			CLOUDFRONT_KEYPAIR_PRIVATE_KEY: z.string().optional(),

			/// Google Auth
			// Provide these to allow Google login
			GOOGLE_CLIENT_ID: z.string().optional(),
			GOOGLE_CLIENT_SECRET: z.string().optional(),

			/// WorkOS SSO
			// Provide these to use WorkOS for enterprise SSO
			WORKOS_CLIENT_ID: z.string().optional(),
			WORKOS_API_KEY: z.string().optional(),

			/// Settings
			CAP_VIDEOS_DEFAULT_PUBLIC: boolString(true).describe(
				"Should videos be public or private by default",
			),
			CAP_ALLOWED_SIGNUP_DOMAINS: z
				.string()
				.optional()
				.describe("Comma-separated list of permitted signup domains"),

			/// AI providers
			DEEPGRAM_API_KEY: z.string().optional().describe("Audio transcription"),
			OPENAI_API_KEY: z.string().optional().describe("AI summaries"),
			GROQ_API_KEY: z.string().optional().describe("AI summaries"),

			/// Cap Cloud
			// These are only needed for Cap Cloud (https://cap.so)
			STRIPE_SECRET_KEY: z.string().optional(),
			STRIPE_WEBHOOK_SECRET: z.string().optional(),
			DISCORD_FEEDBACK_WEBHOOK_URL: z.string().optional(),
			DISCORD_LOGS_WEBHOOK_URL: z.string().optional(),

			/// Tinybird analytics
			TINYBIRD_HOST: z.string().optional(),
			TINYBIRD_TOKEN: z.string().optional(),
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
			VERCEL_AWS_ROLE_ARN: z.string().optional(),
			POSTHOG_PERSONAL_API_KEY: z.string().optional(),
			DUB_API_KEY: z.string().optional(),
			INTERCOM_SECRET: z.string().optional(),

			/// Media Server
			MEDIA_SERVER_URL: z
				.string()
				.optional()
				.describe("URL of the media server for FFmpeg processing"),
			MEDIA_SERVER_WEBHOOK_SECRET: z
				.string()
				.optional()
				.describe("Secret for authenticating media server webhook callbacks"),
			MEDIA_SERVER_WEBHOOK_URL: z
				.string()
				.optional()
				.describe(
					"Base URL for media server webhooks (use host.docker.internal for Docker setups)",
				),

			/// Ignore
			NODE_ENV: z.string(),
			WORKFLOWS_RPC_URL: z.string().optional(),
			WORKFLOWS_RPC_SECRET: z.string().optional(),
		},
		experimental__runtimeEnv: {
			S3_PUBLIC_ENDPOINT: process.env.CAP_AWS_ENDPOINT,
			S3_INTERNAL_ENDPOINT: process.env.CAP_AWS_ENDPOINT,
			...process.env,
			NODE_ENV: process.env.NODE_ENV ?? "production",
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
