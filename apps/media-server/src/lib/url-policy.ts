import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { MiddlewareHandler } from "hono";
import { validateMediaServerSecret } from "./auth";

const blockedRanges = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	blockedRanges.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	blockedRanges.addSubnet(network, prefix, "ipv6");
}

export function isPrivateAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return blockedRanges.check(address, "ipv4");
	if (family === 6) {
		const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		if (mapped?.[1]) return blockedRanges.check(mapped[1], "ipv4");
		return blockedRanges.check(address, "ipv6");
	}
	return true;
}

function hostOf(value: string | undefined): string | null {
	if (!value?.trim()) return null;
	try {
		return new URL(value.trim()).hostname.toLowerCase();
	} catch {
		return null;
	}
}

function normalizeHost(host: string): string {
	return host
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
}

export type UrlPolicy = {
	strictHosts: boolean;
	allowedHosts: string[];
	allowPrivate: boolean;
};

export function getUrlPolicy(
	env: Record<string, string | undefined> = process.env,
): UrlPolicy {
	const explicit = (env.MEDIA_SERVER_ALLOWED_HOSTS ?? "")
		.split(",")
		.map(normalizeHost)
		.filter(Boolean);
	const implicit = [
		env.S3_INTERNAL_ENDPOINT,
		env.S3_PUBLIC_ENDPOINT,
		env.CAP_AWS_ENDPOINT,
		env.MEDIA_SERVER_WEBHOOK_URL,
		env.WEB_URL,
	]
		.map(hostOf)
		.filter((host): host is string => Boolean(host));
	return {
		strictHosts: explicit.length > 0,
		allowedHosts: [...new Set([...explicit, ...implicit])],
		allowPrivate: env.MEDIA_SERVER_ALLOW_PRIVATE_URLS === "true",
	};
}

function hostMatches(host: string, pattern: string): boolean {
	if (pattern.startsWith("*.")) {
		const suffix = pattern.slice(1);
		return host.endsWith(suffix) && host.length > suffix.length;
	}
	return host === pattern;
}

export class BlockedUrlError extends Error {
	constructor(
		readonly url: string,
		readonly reason: string,
	) {
		super(`URL not allowed (${reason}): ${redactUrl(url)}`);
		this.name = "BlockedUrlError";
	}
}

function redactUrl(value: string): string {
	try {
		const url = new URL(value);
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return "<invalid url>";
	}
}

type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) =>
	(await lookup(host, { all: true, verbatim: true })).map(
		(entry) => entry.address,
	);

export async function assertUrlAllowed(
	value: string,
	policy: UrlPolicy = getUrlPolicy(),
	resolve: Resolver = defaultResolver,
): Promise<void> {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new BlockedUrlError(value, "invalid URL");
	}
	if (url.protocol === "file:" && policy.allowPrivate) return;
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new BlockedUrlError(value, `scheme ${url.protocol} is not allowed`);
	}
	const host = normalizeHost(url.hostname);
	const explicitlyAllowed = policy.allowedHosts.some((pattern) =>
		hostMatches(host, pattern),
	);
	if (policy.strictHosts && !explicitlyAllowed) {
		throw new BlockedUrlError(
			value,
			`host ${host} is not in MEDIA_SERVER_ALLOWED_HOSTS`,
		);
	}
	if (explicitlyAllowed || policy.allowPrivate) return;

	let addresses: string[];
	try {
		addresses = isIP(host) ? [host] : await resolve(host);
	} catch {
		throw new BlockedUrlError(value, `host ${host} does not resolve`);
	}
	const privateAddress = addresses.find(isPrivateAddress);
	if (addresses.length === 0 || privateAddress) {
		throw new BlockedUrlError(
			value,
			`host ${host} resolves to private address ${privateAddress ?? "none"}; add it to MEDIA_SERVER_ALLOWED_HOSTS if this is your storage or Cap web host`,
		);
	}
}

const URL_KEY = /urls?$/i;

export function collectUrls(input: unknown, key = ""): string[] {
	if (typeof input === "string") {
		return URL_KEY.test(key) && /^[a-z][a-z0-9+.-]*:/i.test(input)
			? [input]
			: [];
	}
	if (Array.isArray(input)) {
		return input.flatMap((item) => collectUrls(item, key));
	}
	if (input && typeof input === "object") {
		return Object.entries(input).flatMap(([childKey, value]) =>
			collectUrls(value, childKey),
		);
	}
	return [];
}

export const urlPolicyMiddleware: MiddlewareHandler = async (c, next) => {
	if (
		c.req.method !== "POST" ||
		!c.req.header("content-type")?.includes("application/json") ||
		!validateMediaServerSecret(c)
	) {
		return next();
	}
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return next();
	}
	const policy = getUrlPolicy();
	const urls = [...new Set(collectUrls(body))];
	try {
		await Promise.all(urls.map((url) => assertUrlAllowed(url, policy)));
	} catch (error) {
		if (error instanceof BlockedUrlError) {
			console.warn(`[media-server] ${error.message}`);
			return c.json(
				{
					error: "URL not allowed",
					code: "URL_NOT_ALLOWED",
					details: error.message,
				},
				400,
			);
		}
		throw error;
	}
	return next();
};
