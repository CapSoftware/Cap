import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const serverEnv = createEnv({
  server: {
    NODE_ENV: z.string(),
    DATABASE_URL: z.string(),
    DATABASE_MIGRATION_URL: z.string().optional(),
    DATABASE_ENCRYPTION_KEY: z.string().optional(),
    CAP_AWS_ACCESS_KEY: z.string(),
    CAP_AWS_SECRET_KEY: z.string(),
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
    DEEPGRAM_API_KEY: z.string().optional(),
    NEXT_LOOPS_KEY: z.string().optional(),
    STRIPE_SECRET_KEY_TEST: z.string().optional(),
    STRIPE_SECRET_KEY_LIVE: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    DISCORD_FEEDBACK_WEBHOOK_URL: z.string().optional(),
  },
  experimental__runtimeEnv: process.env,
});
