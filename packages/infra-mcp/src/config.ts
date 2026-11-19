export const DEFAULT_API_URL = "https://cap.so";
export const CONSOLE_PATH = "/dashboard/infra";

export type Config = {
	secretKey: string;
	apiUrl: string;
	consoleUrl: string;
};

export class ConfigError extends Error {}

const SECRET_KEY_SHAPE = /^csk_[A-Za-z0-9_-]{8,}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const keySource = `Copy the secret key for your app from ${DEFAULT_API_URL}${CONSOLE_PATH} and set it as CAP_SECRET_KEY in this server's environment.`;

function readSecretKey(raw: string | undefined) {
	const value = raw?.trim() ?? "";
	if (value === "") {
		throw new ConfigError(`CAP_SECRET_KEY is not set. ${keySource}`);
	}
	if (value.startsWith("cpk_")) {
		throw new ConfigError(
			`CAP_SECRET_KEY holds a public key. This server needs the secret key, which starts with csk_. ${keySource}`,
		);
	}
	if (value.startsWith("cut_")) {
		throw new ConfigError(
			`CAP_SECRET_KEY holds an upload token. This server needs the secret key, which starts with csk_. ${keySource}`,
		);
	}
	if (!SECRET_KEY_SHAPE.test(value)) {
		throw new ConfigError(
			`CAP_SECRET_KEY is not a Cap Infra secret key. It starts with csk_ and has no spaces or quotes. ${keySource}`,
		);
	}
	return value;
}

function readApiUrl(raw: string | undefined) {
	const value = raw?.trim() || DEFAULT_API_URL;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ConfigError(
			`CAP_API_URL is not a URL. Leave it unset to use ${DEFAULT_API_URL}.`,
		);
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new ConfigError(
			"CAP_API_URL must be an origin with an optional path, with no credentials, query or fragment.",
		);
	}
	const local = LOCAL_HOSTS.has(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
		throw new ConfigError(
			"CAP_API_URL must use https. Plain http is only accepted for localhost.",
		);
	}
	return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export function readConfig(
	env: Record<string, string | undefined> = process.env,
): Config {
	const secretKey = readSecretKey(env.CAP_SECRET_KEY);
	const apiUrl = readApiUrl(env.CAP_API_URL);
	return { secretKey, apiUrl, consoleUrl: `${apiUrl}${CONSOLE_PATH}` };
}
