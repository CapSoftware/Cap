export const NODE_ENV = process.env.NODE_ENV || "";

type BuildEnv = Readonly<{
	NEXT_PUBLIC_IS_CAP?: string;
	NEXT_PUBLIC_OPENPANEL_CLIENT_ID?: string;
	NEXT_PUBLIC_OPENPANEL_API_URL?: string;
	NEXT_PUBLIC_WEB_URL: string;
	NEXT_PUBLIC_DOCKER_BUILD?: string;
}>;

const CLIENT_PREFIX = "NEXT_PUBLIC_";

let _env: BuildEnv;

// Checked by hand instead of createEnv with a zod schema: that pair shipped zod
// and t3-env (34 KB gzipped) to every client route that reads buildEnv. The
// behaviour is pinned against createEnv in apps/web/__tests__/unit/build-env.test.ts.
const create = (): BuildEnv => {
	const webUrl = process.env.WEB_URL ?? process.env.NEXT_PUBLIC_WEB_URL;

	if (typeof webUrl !== "string") {
		console.error("❌ Invalid environment variables:", [
			{
				expected: "string",
				code: "invalid_type",
				path: ["NEXT_PUBLIC_WEB_URL"],
				message: "Invalid input: expected string, received undefined",
			},
		]);
		throw new Error("Invalid environment variables");
	}

	const values: BuildEnv = {
		NEXT_PUBLIC_IS_CAP: process.env.NEXT_PUBLIC_IS_CAP,
		NEXT_PUBLIC_OPENPANEL_CLIENT_ID:
			process.env.NEXT_PUBLIC_OPENPANEL_CLIENT_ID,
		NEXT_PUBLIC_OPENPANEL_API_URL: process.env.NEXT_PUBLIC_OPENPANEL_API_URL,
		NEXT_PUBLIC_WEB_URL: webUrl,
		NEXT_PUBLIC_DOCKER_BUILD: process.env.NEXT_PUBLIC_DOCKER_BUILD,
	};

	const browserWindow = (globalThis as { window?: object }).window;
	const isServer = browserWindow === undefined || "Deno" in browserWindow;

	return new Proxy(values, {
		get(target, key) {
			if (typeof key !== "string") return undefined;
			if (key === "__esModule" || key === "$$typeof") return undefined;
			if (
				!isServer &&
				!key.startsWith(CLIENT_PREFIX) &&
				!(key in Object.prototype)
			) {
				throw new Error(
					"❌ Attempted to access a server-side environment variable on the client",
				);
			}

			return Reflect.get(target, key);
		},
	});
};

export const buildEnv = new Proxy({} as typeof _env, {
	get(_, key) {
		if (typeof key !== "string") return undefined;
		if (!_env) _env = create();

		return _env[key as keyof typeof _env];
	},
});
