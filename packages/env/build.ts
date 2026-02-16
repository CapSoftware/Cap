process.env.SKIP_ENV_VALIDATION = "true";
import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const NODE_ENV = process.env.NODE_ENV || "";

let _env: ReturnType<typeof create>;

const create = () =>
	createEnv({
	
		skipValidation: true,client: {
			NEXT_PUBLIC_IS_CAP: z.string().optional(),
			NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
			NEXT_PUBLIC_POSTHOG_HOST: z.string().optional(),
			NEXT_PUBLIC_META_PIXEL_ID: z.string().optional(),
			NEXT_PUBLIC_GOOGLE_AW_ID: z.string().optional(),
			NEXT_PUBLIC_WEB_URL: z.string(),
			NEXT_PUBLIC_DOCKER_BUILD: z.string().optional(),
		},
		runtimeEnv: {
			NEXT_PUBLIC_IS_CAP: process.env.NEXT_PUBLIC_IS_CAP,
			NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
			NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
			NEXT_PUBLIC_META_PIXEL_ID: process.env.NEXT_PUBLIC_META_PIXEL_ID,
			NEXT_PUBLIC_GOOGLE_AW_ID: process.env.NEXT_PUBLIC_GOOGLE_AW_ID,
			NEXT_PUBLIC_WEB_URL:
				process.env.WEB_URL ?? process.env.NEXT_PUBLIC_WEB_URL,
			NEXT_PUBLIC_DOCKER_BUILD: process.env.NEXT_PUBLIC_DOCKER_BUILD,
		},
	});

// Environment variables that are needed in the build process, and may be incorrect on the client.
// Some are only provided by `NEXT_PUBLIC`, but others can be provdied at runtime
export const buildEnv = new Proxy({} as typeof _env, {
	get(_, key) {
		if (!_env) _env = create();

		return (_env as any)[key];
	},
});
