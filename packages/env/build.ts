import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const NODE_ENV = process.env.NODE_ENV || "";

let _env: ReturnType<typeof create>;

const create = () =>
	createEnv({
		client: {
			NEXT_PUBLIC_IS_CAP: z.string().optional(),
			NEXT_PUBLIC_OPENPANEL_CLIENT_ID: z.string().optional(),
			NEXT_PUBLIC_OPENPANEL_API_URL: z.string().optional(),
			NEXT_PUBLIC_WEB_URL: z.string(),
			NEXT_PUBLIC_DOCKER_BUILD: z.string().optional(),
		},
		runtimeEnv: {
			NEXT_PUBLIC_IS_CAP: process.env.NEXT_PUBLIC_IS_CAP,
			NEXT_PUBLIC_OPENPANEL_CLIENT_ID:
				process.env.NEXT_PUBLIC_OPENPANEL_CLIENT_ID,
			NEXT_PUBLIC_OPENPANEL_API_URL: process.env.NEXT_PUBLIC_OPENPANEL_API_URL,
			NEXT_PUBLIC_WEB_URL:
				process.env.WEB_URL ?? process.env.NEXT_PUBLIC_WEB_URL,
			NEXT_PUBLIC_DOCKER_BUILD: process.env.NEXT_PUBLIC_DOCKER_BUILD,
		},
	});

export const buildEnv = new Proxy({} as typeof _env, {
	get(_, key) {
		if (typeof key !== "string") return undefined;
		if (!_env) _env = create();

		return _env[key as keyof typeof _env];
	},
});
