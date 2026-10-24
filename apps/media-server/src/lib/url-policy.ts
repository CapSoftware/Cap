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
	["::", 96],
	["64:ff9b::", 96],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
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

function defaultPort(protocol: string): string {
	if (protocol === "http:") return "80";
	if (protocol === "https:") return "443";
	return "";
}

function originOf(value: string | undefined): TrustedOrigin | null {
	if (!value?.trim()) return null;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return {
			host: normalizeHost(url.hostname),
			port: url.port || defaultPort(url.protocol),
		};
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

export type TrustedOrigin = { host: string; port: string };

export type UrlPolicy = {
	strictHosts: boolean;
	allowedHosts: string[];
	trustedOrigins: TrustedOrigin[];
	allowPrivate: boolean;
};

export function getUrlPolicy(
	env: Record<string, string | undefined> = process.env,
): UrlPolicy {
	const explicit = (env.MEDIA_SERVER_ALLOWED_HOSTS ?? "")
		.split(",")
		.map(normalizeHost)
		.filter(Boolean);
	const trustedOrigins = [
		env.S3_INTERNAL_ENDPOINT,
		env.S3_PUBLIC_ENDPOINT,
		env.CAP_AWS_ENDPOINT,
		env.MEDIA_SERVER_WEBHOOK_URL,
		env.WEB_URL,
	]
		.map(originOf)
		.filter((origin): origin is TrustedOrigin => Boolean(origin));
	const seen = new Set<string>();
	return {
		strictHosts: explicit.length > 0,
		allowedHosts: [...new Set(explicit)],
		trustedOrigins: trustedOrigins.filter((origin) => {
			const key = `${origin.host}\0${origin.port}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}),
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

export function blockedUrlPayload(
	error: unknown,
): { error: string; code: "URL_NOT_ALLOWED"; details: string } | null {
	if (!(error instanceof BlockedUrlError)) return null;
	return {
		error: "URL not allowed",
		code: "URL_NOT_ALLOWED",
		details: error.message,
	};
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

async function checkedAddresses(
	value: string,
	policy: UrlPolicy = getUrlPolicy(),
	resolve: Resolver = defaultResolver,
): Promise<string[]> {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new BlockedUrlError(value, "invalid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new BlockedUrlError(value, `scheme ${url.protocol} is not allowed`);
	}
	const host = normalizeHost(url.hostname);
	const port = url.port || defaultPort(url.protocol);
	const explicitlyAllowed = policy.allowedHosts.some((pattern) =>
		hostMatches(host, pattern),
	);
	const trustedOrigin = policy.trustedOrigins.some(
		(origin) => origin.host === host && origin.port === port,
	);
	if (explicitlyAllowed || trustedOrigin || policy.allowPrivate) return [];
	if (policy.strictHosts) {
		throw new BlockedUrlError(
			value,
			`host ${host} is not in MEDIA_SERVER_ALLOWED_HOSTS`,
		);
	}

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
	return addresses;
}

export async function assertUrlAllowed(
	value: string,
	policy: UrlPolicy = getUrlPolicy(),
	resolve: Resolver = defaultResolver,
): Promise<void> {
	await checkedAddresses(value, policy, resolve);
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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

type PinnedRequestInit = RequestInit & {
	proxy?: false;
	tls?: { serverName: string };
};
type Fetcher = (input: string, init?: PinnedRequestInit) => Promise<Response>;

async function fetchChecked(
	input: string,
	init: RequestInit,
	policy: UrlPolicy,
	resolve: Resolver,
	fetcher: Fetcher,
): Promise<Response> {
	init.signal?.throwIfAborted();
	const addresses = await checkedAddresses(input, policy, resolve);
	init.signal?.throwIfAborted();
	if (addresses.length === 0) return fetcher(input, withManualRedirect(init));
	const origin = new URL(input);
	const headers = new Headers(init.headers);
	headers.set("Host", origin.host);
	// Dial only checked addresses. Keep the original authority for routing and
	// TLS verification, and bypass proxies that could resolve the host again.
	const candidates = ["GET", "HEAD"].includes(
		(init.method ?? "GET").toUpperCase(),
	)
		? addresses
		: addresses.slice(0, 1);
	for (const [index, address] of candidates.entries()) {
		const pinned = new URL(origin);
		pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
		try {
			const response = await fetcher(pinned.toString(), {
				...withManualRedirect(init),
				headers,
				proxy: false,
				...(origin.protocol === "https:"
					? { tls: { serverName: normalizeHost(origin.hostname) } }
					: {}),
			});
			Object.defineProperty(response, "url", {
				value: input,
				configurable: true,
			});
			return response;
		} catch (error) {
			init.signal?.throwIfAborted();
			if (index === candidates.length - 1) throw error;
		}
	}
	throw new BlockedUrlError(input, "no connection address available");
}

async function redirectTarget(
	response: Response,
	current: string,
): Promise<string | null> {
	if (!REDIRECT_STATUSES.has(response.status)) return null;
	const location = response.headers.get("location");
	if (!location) return null;
	return new URL(location, current).toString();
}

function withManualRedirect(init: RequestInit): RequestInit {
	const body = init.body;
	return {
		...init,
		body: body instanceof Blob ? body.slice() : body,
		redirect: "manual",
	};
}

export async function resolveAllowedUrl(
	input: string,
	policy: UrlPolicy = getUrlPolicy(),
	resolve: Resolver = defaultResolver,
	fetcher: Fetcher = fetch,
	signal?: AbortSignal,
): Promise<string> {
	let current = input;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		let response = await fetchChecked(
			current,
			{
				method: "HEAD",
				redirect: "manual",
				signal,
			},
			policy,
			resolve,
			fetcher,
		);
		if (response.status === 405 || response.status === 501) {
			await response.body?.cancel();
			response = await fetchChecked(
				current,
				{
					method: "GET",
					redirect: "manual",
					signal,
				},
				policy,
				resolve,
				fetcher,
			);
		}
		const next = await redirectTarget(response, current);
		await response.body?.cancel();
		if (!next) return current;
		if (hop === MAX_REDIRECTS) {
			throw new BlockedUrlError(current, "too many redirects");
		}
		current = next;
	}
	throw new BlockedUrlError(current, "too many redirects");
}

export async function fetchAllowed(
	input: string,
	init: RequestInit = {},
	policy: UrlPolicy = getUrlPolicy(),
	resolve: Resolver = defaultResolver,
	fetcher: Fetcher = fetch,
): Promise<Response> {
	let current = input;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const response = await fetchChecked(
			current,
			init,
			policy,
			resolve,
			fetcher,
		);
		if (
			response.status >= 300 &&
			response.status < 400 &&
			init.redirect === "error"
		) {
			await response.body?.cancel();
			throw new TypeError("Redirects are not allowed for this request");
		}
		if (init.redirect === "manual") return response;
		const next = await redirectTarget(response, current);
		if (!next) return response;
		await response.body?.cancel();
		if (hop === MAX_REDIRECTS) {
			throw new BlockedUrlError(current, "too many redirects");
		}
		if (new URL(next).origin !== new URL(current).origin) {
			const headers = new Headers(init.headers);
			for (const name of ["authorization", "cookie", "x-media-server-secret"])
				headers.delete(name);
			init = { ...init, headers };
		}
		if (
			response.status === 303 ||
			((response.status === 301 || response.status === 302) &&
				init.method?.toUpperCase() === "POST")
		) {
			const headers = new Headers(init.headers);
			headers.delete("content-type");
			headers.delete("content-length");
			init = { ...init, method: "GET", body: undefined, headers };
		}
		current = next;
	}
	throw new BlockedUrlError(current, "too many redirects");
}

export const urlPolicyMiddleware: MiddlewareHandler = async (c, next) => {
	if (c.req.method !== "POST" || !validateMediaServerSecret(c)) {
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
