import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const NODE_ENV = process.env.NODE_ENV as string;

export const clientEnv = createEnv({
	client: {
		NEXT_PUBLIC_IS_CAP: z.string().optional(),
		NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
		NEXT_PUBLIC_POSTHOG_HOST: z.string().optional(),
	},
	runtimeEnv: {
		NEXT_PUBLIC_IS_CAP: process.env.NEXT_PUBLIC_IS_CAP,
		NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
		NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
	},
});
