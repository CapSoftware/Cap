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

export function isPrivateAddress(address: string) {
	const family = isIP(address);
	if (family === 4) return privateRanges.check(address, "ipv4");
	if (family === 6) return privateRanges.check(address, "ipv6");
	return true;
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
		return addresses.length === 0 || addresses.some(isPrivateAddress);
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
		const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
		if (blocked) {
			const blockedError: NodeJS.ErrnoException = new Error(
				`Refused to connect to private address ${blocked.address}`,
			);
			blockedError.code = "ECONNREFUSED";
			callback(blockedError, address, family);
			return;
		}

		callback(null, address, family);
	});
};

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
