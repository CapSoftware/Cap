import { lookup } from "node:dns/promises";
import { MediaInputPolicyError } from "./media-input-policy";

const mediaFetch: typeof fetch = globalThis.fetch.bind(globalThis);

const MAX_MEDIA_REDIRECTS = 5;
const MAX_ADDRESSES_TRIED = 4;

// "private" addresses are only reachable from inside a network, and are
// fetched only for hosts the operator has named. "reserved" ones (link-local,
// which is where cloud metadata lives, unspecified, multicast) never are.
export type HostAddressClass = "public" | "private" | "reserved";

function classifyIpv4(a: number, b: number, c: number): HostAddressClass {
	if (
		a === 0 ||
		(a === 169 && b === 254) ||
		(a === 192 && b === 0 && c === 0) ||
		a >= 224
	) {
		return "reserved";
	}
	if (
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19))
	) {
		return "private";
	}
	return "public";
}

// The eight 16-bit groups of an IPv6 literal, or null when it is not one.
// URL parsing writes an embedded IPv4 address as two hex groups, so both
// spellings are read.
function ipv6Groups(host: string): number[] | null {
	if (!host.includes(":")) return null;
	let text = host;
	const dotted = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (dotted) {
		const [a, b, c, d] = dotted.slice(2).map(Number) as [
			number,
			number,
			number,
			number,
		];
		if ([a, b, c, d].some((part) => part > 255)) return null;
		text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const parse = (part: string) =>
		part === ""
			? []
			: part.split(":").map((group) => Number.parseInt(group, 16));
	const head = parse(halves[0] ?? "");
	const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
	return groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}

function classifyIpv6(groups: number[]): HostAddressClass {
	const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const embeddedIpv4 = (high: number, low: number) =>
		classifyIpv4(high >> 8, high & 0xff, low >> 8);
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
		if (g5 === 0xffff) return embeddedIpv4(g6, g7);
		if (g5 === 0) {
			if (g6 === 0 && g7 === 0) return "reserved";
			if (g6 === 0 && g7 === 1) return "private";
			return embeddedIpv4(g6, g7);
		}
	}
	// IPv4 addresses reached through IPv6: NAT64 and 6to4 carry the address
	// they lead to, so they are judged by it.
	if (g0 === 0x64 && g1 === 0xff9b) {
		return g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0
			? embeddedIpv4(g6, g7)
			: "private";
	}
	if (g0 === 0x2002) return embeddedIpv4(g1, g2);
	if (g0 === 0x2001 && g1 === 0) return "private";
	if (
		(g0 & 0xffc0) === 0xfe80 ||
		(g0 & 0xff00) === 0xff00 ||
		(g0 === 0xfd00 && g1 === 0x0ec2)
	) {
		return "reserved";
	}
	if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfec0) return "private";
	return "public";
}

function normalizeHost(hostname: string): string {
	return hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
}

// The class of an address written as a literal, or null for a name, which
// says nothing until it is resolved. That includes localhost names: resolvers
// are not bound to answer them with loopback.
export function classifyHostLiteral(hostname: string): HostAddressClass | null {
	const host = normalizeHost(hostname);
	const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (v4) return classifyIpv4(Number(v4[1]), Number(v4[2]), Number(v4[3]));
	const groups = ipv6Groups(host);
	return groups ? classifyIpv6(groups) : null;
}

export function isPrivateHostLiteral(hostname: string): boolean {
	const host = normalizeHost(hostname);
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		(classifyHostLiteral(host) ?? "public") !== "public"
	);
}

function isHttpProtocol(url: URL): boolean {
	return url.protocol === "http:" || url.protocol === "https:";
}

// Not an input policy violation: the address is what this server was given,
// which is a configuration fault more often than an uploader's doing.
export class MediaAddressError extends Error {
	override name = "MediaAddressError";
}

export interface MediaAddressPolicy {
	privateHosts?: ReadonlySet<string>;
	resolveHost?: (hostname: string) => Promise<string[]>;
	fetchImpl?: typeof fetch;
}

// Storage on a private network (a self-hosted bucket, a local dev endpoint)
// has to be named here before it is read: host names, or * for any.
export function parsePrivateMediaHosts(value: string | undefined): Set<string> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((host) => normalizeHost(host.trim()))
			.filter(Boolean),
	);
}

const NO_PRIVATE_HOSTS: ReadonlySet<string> = new Set();

function privateMediaHosts(policy: MediaAddressPolicy): ReadonlySet<string> {
	return (
		policy.privateHosts ??
		parsePrivateMediaHosts(process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS)
	);
}

const RESOLVED_HOST_TTL_MS = 30_000;
const MAX_RESOLVED_HOSTS = 256;
const resolvedHosts = new Map<
	string,
	{ at: number; addresses: Promise<string[]> }
>();

async function lookupHost(hostname: string): Promise<string[]> {
	const records = await lookup(hostname, { all: true });
	return records.map((record) => record.address);
}

// Held for a short while so a probe's many range requests cost one lookup.
// Requests connect to these same addresses, so a held answer is never used
// for anything it was not checked for.
function resolveHostCached(hostname: string): Promise<string[]> {
	const now = Date.now();
	const cached = resolvedHosts.get(hostname);
	if (cached && now - cached.at < RESOLVED_HOST_TTL_MS) return cached.addresses;
	const addresses = lookupHost(hostname);
	resolvedHosts.delete(hostname);
	resolvedHosts.set(hostname, { at: now, addresses });
	if (resolvedHosts.size > MAX_RESOLVED_HOSTS) {
		const oldest = resolvedHosts.keys().next().value;
		if (oldest !== undefined) resolvedHosts.delete(oldest);
	}
	addresses.catch(() => {
		if (resolvedHosts.get(hostname)?.addresses === addresses)
			resolvedHosts.delete(hostname);
	});
	return addresses;
}

const CLASS_RANK: Record<HostAddressClass, number> = {
	public: 0,
	private: 1,
	reserved: 2,
};

interface CheckedMediaUrl {
	url: URL;
	// The addresses the host resolved to, all of them checked, or null when
	// the host is itself an address.
	addresses: string[] | null;
}

// The one decision on whether a media URL may be requested. A name is judged
// by every address it resolves to, so one that also answers with a private
// address is treated as private.
async function checkMediaUrl(
	value: string | URL,
	policy: MediaAddressPolicy,
): Promise<CheckedMediaUrl> {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new MediaAddressError("Media address is not a valid URL");
	}
	if (!isHttpProtocol(url)) {
		throw new MediaAddressError("Media address must be an http or https URL");
	}
	const host = normalizeHost(url.hostname);
	let addressClass = classifyHostLiteral(host);
	let addresses: string[] | null = null;
	if (addressClass === null) {
		addresses = await (policy.resolveHost ?? resolveHostCached)(host).catch(
			() => [],
		);
		// A lookup that fails is a fault that may clear, not a refusal.
		if (addresses.length === 0) {
			throw new Error("Media host could not be resolved");
		}
		addressClass = "public";
		for (const address of addresses) {
			const resolved = classifyHostLiteral(address) ?? "reserved";
			if (CLASS_RANK[resolved] > CLASS_RANK[addressClass])
				addressClass = resolved;
		}
	}
	const privateHosts = privateMediaHosts(policy);
	if (
		addressClass === "public" ||
		(addressClass === "private" &&
			(privateHosts.has("*") || privateHosts.has(host)))
	) {
		return { url, addresses };
	}
	throw new MediaAddressError(
		addressClass === "private"
			? "Media address is on a private network. Name its host in MEDIA_SERVER_INTERNAL_MEDIA_HOSTS to read from it."
			: "Media address is not one this server may read from",
	);
}

export async function assertMediaUrlAllowed(
	value: string | URL,
	policy: MediaAddressPolicy = {},
): Promise<void> {
	await checkMediaUrl(value, policy);
}

// A request to a name is sent to one of the addresses that were checked,
// with the name kept for the Host header and the certificate. Left to resolve
// the name again, the connection could go somewhere the check never saw.
async function fetchChecked(
	{ url, addresses }: CheckedMediaUrl,
	init: Parameters<typeof fetch>[1],
	fetchImpl: typeof fetch,
): Promise<Response> {
	if (addresses === null) return fetchImpl(url, init);
	const given = init?.headers;
	let headers: NonNullable<typeof given>;
	if (given instanceof Headers || Array.isArray(given)) {
		headers = new Headers(given);
		headers.set("Host", url.host);
	} else {
		headers = { ...given, Host: url.host };
	}
	const pinnedInit = {
		...init,
		headers,
		...(url.protocol === "https:" && {
			tls: { serverName: normalizeHost(url.hostname) },
		}),
	};
	const ordered = [
		...addresses.filter((address) => !address.includes(":")),
		...addresses.filter((address) => address.includes(":")),
	].slice(0, MAX_ADDRESSES_TRIED);
	let lastError: unknown;
	for (const address of ordered) {
		const target = new URL(url);
		target.hostname = address.includes(":") ? `[${address}]` : address;
		try {
			return await fetchImpl(target, pinnedInit);
		} catch (error) {
			if (init?.signal?.aborted) throw error;
			lastError = error;
		}
	}
	throw lastError;
}

// One checked request, for callers that handle a redirect themselves.
export async function fetchCheckedMediaUrl(
	value: string | URL,
	init?: Parameters<typeof fetch>[1],
	policy: MediaAddressPolicy = {},
): Promise<Response> {
	return fetchChecked(
		await untilAborted(checkMediaUrl(value, policy), init?.signal),
		init,
		policy.fetchImpl ?? mediaFetch,
	);
}

// For inputs that may also be local paths, which FFmpeg reads as files.
export async function assertRemoteMediaAllowed(input: string): Promise<void> {
	if (/^https?:\/\//i.test(input)) await assertMediaUrlAllowed(input);
}

function untilAborted<T>(
	work: Promise<T>,
	signal?: AbortSignal | null,
): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", onAbort));
	});
}

// A remote input is only ever given by the web app, but what it leads to is
// not: a playlist names other files, a server can redirect, and a name can
// resolve anywhere. Every request, and every hop of a redirect, is checked
// before it is made.
export function createGuardedMediaFetch(
	rootUrl: string,
	policy: MediaAddressPolicy = {},
): typeof fetch {
	const root = new URL(rootUrl);
	const guarded = async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	): Promise<Response> => {
		let url = new URL(
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url,
		);
		for (let hop = 0; hop <= MAX_MEDIA_REDIRECTS; hop++) {
			// A named private host vouches for the address this server was
			// given, not for wherever that address leads: anywhere else has to
			// be public.
			const elsewhere = url.origin !== root.origin;
			let checked: CheckedMediaUrl;
			try {
				checked = await untilAborted(
					checkMediaUrl(
						url,
						elsewhere ? { ...policy, privateHosts: NO_PRIVATE_HOSTS } : policy,
					),
					init?.signal,
				);
			} catch (error) {
				if (!(error instanceof MediaAddressError) || !elsewhere) throw error;
				throw new MediaInputPolicyError(
					"the media location redirected to an address that is not allowed",
				);
			}
			const response = await fetchChecked(
				checked,
				{ ...init, redirect: "manual" },
				policy.fetchImpl ?? mediaFetch,
			);
			const location = response.headers.get("location");
			if (response.status < 300 || response.status >= 400 || !location) {
				return response;
			}
			await response.body?.cancel().catch(() => {});
			url = new URL(location, url);
		}
		throw new Error("Media input redirected too many times");
	};
	return guarded as typeof fetch;
}
