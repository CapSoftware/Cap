import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { buildEnv, NODE_ENV } from "@cap/env";

const privateRanges = new BlockList();

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
	privateRanges.addSubnet(network, prefix, "ipv4");
}

// Never dialled, but unlike the ranges above they do not condemn the whole
// name: a host with a public address and one of these (a 6to4 or Teredo
// AAAA, say) connects to the public one, as it did before these were added.
const reservedRanges = new BlockList();

for (const [network, prefix] of [
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
] as const) {
	reservedRanges.addSubnet(network, prefix, "ipv4");
}

// BlockList already applies the IPv4 rules to IPv4-mapped addresses
// (::ffff:a.b.c.d and ::ffff:7f00:1). Adding ::ffff:0:0/96 here would also
// match every plain IPv4 address, so only the IPv4-compatible (::/96) and NAT64
// (64:ff9b::/96) forms are blocked outright.
for (const [network, prefix] of [
	["::", 96],
	["64:ff9b::", 96],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
	["ff00::", 8],
] as const) {
	privateRanges.addSubnet(network, prefix, "ipv6");
}

// 6to4 (2002::/16) and Teredo (2001::/32) carry an IPv4 address inside them,
// so a relay could deliver the request to a private IPv4 host that the IPv4
// rules never saw.
for (const [network, prefix] of [
	["64:ff9b:1::", 48],
	["100::", 64],
	["2001::", 32],
	["2001:db8::", 32],
	["2002::", 16],
] as const) {
	reservedRanges.addSubnet(network, prefix, "ipv6");
}

const inRanges = (ranges: BlockList, address: string) => {
	const family = isIP(address);
	if (family === 4) return ranges.check(address, "ipv4");
	if (family === 6) return ranges.check(address, "ipv6");
	return true;
};

// True for any address that is never dialled.
export function isPrivateAddress(address: string) {
	return inRanges(privateRanges, address) || inRanges(reservedRanges, address);
}

// The addresses of a DNS answer that may be dialled, or null when the name is
// refused. One private address anywhere refuses the whole name. Reserved
// addresses are dropped, and the name is refused only when nothing is left.
export function dialableAddresses<T>(
	entries: readonly T[],
	addressOf: (entry: T) => string,
): T[] | null {
	if (entries.some((entry) => inRanges(privateRanges, addressOf(entry))))
		return null;
	const usable = entries.filter(
		(entry) => !inRanges(reservedRanges, addressOf(entry)),
	);
	return usable.length === 0 ? null : usable;
}

export function shouldBlockPrivateS3Endpoints() {
	return buildEnv.NEXT_PUBLIC_IS_CAP === "true" && NODE_ENV === "production";
}

export async function isBlockedS3Endpoint(
	endpoint: string,
	resolve: (hostname: string) => Promise<string[]> = async (hostname) =>
		(await lookup(hostname, { all: true, verbatim: true })).map(
			(entry) => entry.address,
		),
) {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return true;
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") return true;
	if (url.username || url.password) return true;

	const hostname = url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (!hostname) return true;
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".internal")
	) {
		return true;
	}

	if (isIP(hostname)) return isPrivateAddress(hostname);

	try {
		const addresses = await resolve(hostname);
		return dialableAddresses(addresses, (address) => address) === null;
	} catch {
		return true;
	}
}

export const publicOnlyLookup: LookupFunction = (
	hostname,
	options,
	callback,
) => {
	dnsLookup(hostname, options, (error, address, family) => {
		if (error) {
			callback(error, address, family);
			return;
		}

		const addresses: LookupAddress[] = Array.isArray(address)
			? address
			: [{ address, family }];
		const usable = dialableAddresses(addresses, (entry) => entry.address);
		if (!usable) {
			const blocked =
				addresses.find((entry) => isPrivateAddress(entry.address)) ??
				addresses[0];
			const blockedError: NodeJS.ErrnoException = new Error(
				`Refused to connect to private address ${blocked?.address ?? hostname}`,
			);
			blockedError.code = "ECONNREFUSED";
			callback(blockedError, address, family);
			return;
		}

		// Only the addresses that passed are handed to the connection.
		if (Array.isArray(address)) callback(null, usable, family);
		else callback(null, address, family);
	});
};

const restrictedCustomStorageHostSuffixes = [
	"trycloudflare.com",
	"lhr.life",
	"localhost.run",
	"serveo.net",
	"serveousercontent.com",
	"ngrok.io",
	"ngrok.app",
	"ngrok-free.app",
	"ngrok-free.dev",
	"ngrok.dev",
	"loca.lt",
	"localtunnel.me",
	"pinggy.link",
	"pinggy.online",
	"a.pinggy.io",
	"bore.pub",
	"tunnelmole.net",
	"devtunnels.ms",
	"telebit.io",
	"localxpose.io",
	"loclx.io",
	"ply.gg",
	"playit.gg",
	"serveo.io",
	"zrok.io",
	"share.zrok.io",
	"packetriot.net",
	"webhook.site",
	"requestbin.net",
	"pipedream.net",
	"oast.fun",
	"oast.pro",
	"oast.live",
	"oast.site",
	"oast.online",
	"oast.me",
	"interact.sh",
	"burpcollaborator.net",
	"oastify.com",
];

export function isRestrictedCustomStorageHost(endpoint: string) {
	let url: URL;
	try {
		url = new URL(endpoint.trim());
	} catch {
		return false;
	}
	const hostname = url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (isIP(hostname)) return true;
	return restrictedCustomStorageHostSuffixes.some(
		(suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
	);
}

export const isDisallowedCustomStorageEndpoint = (endpoint: string) =>
	Boolean(endpoint.trim()) &&
	shouldBlockPrivateS3Endpoints() &&
	isRestrictedCustomStorageHost(endpoint);

export const blockedS3EndpointMessage =
	"Invalid endpoint. Please provide a public S3-compatible endpoint URL.";

export const isDisallowedS3Endpoint = async (endpoint: string) =>
	Boolean(endpoint) &&
	shouldBlockPrivateS3Endpoints() &&
	(await isBlockedS3Endpoint(endpoint));

export const publicOnlyS3Agents = () =>
	shouldBlockPrivateS3Endpoints()
		? {
				httpAgent: new HttpAgent({ lookup: publicOnlyLookup }),
				httpsAgent: new HttpsAgent({ lookup: publicOnlyLookup }),
			}
		: undefined;
