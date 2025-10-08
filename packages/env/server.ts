import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

const envDirectoryPath = dirname(fileURLToPath(import.meta.url));
const appsDirectoryPath = join(envDirectoryPath, "..", "apps");

const manifestSchema = z
	.object({
		requiredEnvVars: z.array(z.string()).optional(),
	})
	.passthrough();

const skipAppEnvValidation = process.env.SKIP_APP_ENV_VALIDATION === "true";

const allRequiredEnvVars = (() => {
	if (skipAppEnvValidation) {
		console.log(
			"[env/server] SKIP_APP_ENV_VALIDATION=true; skipping app manifest scan.",
		);
		return Object.freeze([] as string[]);
	}

	const discovered = new Set<string>();
	const manifestCandidates = new Map<string, string>();

	const scanDirectoryForManifests = (
		directoryPath: string,
		skipNames: ReadonlySet<string>,
	) => {
		const entries = readdirSync(directoryPath, { withFileTypes: true });

		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}

			if (skipNames.has(entry.name)) {
				continue;
			}

			const manifestPath = join(directoryPath, entry.name, "config.json");

			if (!existsSync(manifestPath)) {
				continue;
			}

			manifestCandidates.set(manifestPath, entry.name);
		}
	};

	scanDirectoryForManifests(
		appsDirectoryPath,
		new Set(["core", "dist", "node_modules", "src"]),
	);

	const nestedAppsDirectoryPath = join(appsDirectoryPath, "src");
	if (existsSync(nestedAppsDirectoryPath)) {
		scanDirectoryForManifests(nestedAppsDirectoryPath, new Set(["core"]));
	}

	for (const [manifestPath, appName] of manifestCandidates.entries()) {
		const parsed = manifestSchema.safeParse(
			JSON.parse(readFileSync(manifestPath, "utf8")),
		);

		if (!parsed.success) {
			throw new Error(
				`Invalid manifest at ${manifestPath}: ${parsed.error.message}`,
			);
		}

		const requiredVars = parsed.data.requiredEnvVars ?? [];

		for (const key of requiredVars) {
			discovered.add(key);
		}
	}

	const result = Object.freeze(Array.from(discovered));
	return result;
})();

const boolString = (_default = false) =>
	z
		.string()
		.optional()
		.default(_default ? "true" : "false")
		.transform((v) => v === "true")
		.pipe(z.boolean());

const baseServerSchema = {
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
	STRIPE_WEBHOOK_SECRET: z.string().optional(),
	DISCORD_FEEDBACK_WEBHOOK_URL: z.string().optional(),
	DISCORD_CLIENT_ID: z.string().optional(),
	DISCORD_CLIENT_SECRET: z.string().optional(),
	DISCORD_BOT_TOKEN: z.string().optional(),
	DISCORD_REDIRECT_URI: z.string().optional(),
	DISCORD_REQUIRED_PERMISSIONS: z.string().optional(),
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
	REMOTE_WORKFLOW_URL: z.string().optional(),
	REMOTE_WORKFLOW_SECRET: z.string().optional(),
} satisfies Record<string, z.ZodTypeAny>;

const appEnvSchema = Object.fromEntries(
	allRequiredEnvVars.map((key) => [key, z.string()]),
) as Record<string, z.ZodTypeAny>;

function createServerEnv() {
	const env = createEnv({
		server: {
			...baseServerSchema,
			...appEnvSchema,
		},
		experimental__runtimeEnv: {
			...process.env,
			VERCEL_URL_HOST: process.env.VERCEL_URL,
			VERCEL_BRANCH_URL_HOST: process.env.VERCEL_BRANCH_URL,
			VERCEL_PROJECT_PRODUCTION_URL_HOST:
				process.env.VERCEL_PROJECT_PRODUCTION_URL,
		},
	});

	return env;
}

let _cached: ReturnType<typeof createServerEnv> | undefined;
export const serverEnv = () => {
	if (_cached) return _cached;
	_cached = createServerEnv();
	return _cached;
};
