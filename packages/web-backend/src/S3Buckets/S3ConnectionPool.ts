import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { BlockList, isIP, type LookupFunction, Socket } from "node:net";
import { buildEnv, NODE_ENV } from "@cap/env";
import { Effect } from "effect";

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
] as const)
	privateRanges.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
	["::", 96],
	["64:ff9b::", 96],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
	["ff00::", 8],
] as const)
	privateRanges.addSubnet(network, prefix, "ipv6");

export function isPrivateAddress(address: string) {
	const family = isIP(address);
	if (family === 4) return privateRanges.check(address, "ipv4");
	if (family === 6) return privateRanges.check(address, "ipv6");
	return true;
}

// User-configured storage hosts are only ever dialled at public addresses, whatever their DNS says later.
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

function blocksPrivateStorageHosts() {
	try {
		return buildEnv.NEXT_PUBLIC_IS_CAP === "true" && NODE_ENV === "production";
	} catch {
		return false;
	}
}

function boundIdleConnections<T extends HttpAgent>(agent: T) {
	// Idle custom hosts must release their slots without timing out an active copy.
	const keepSocketAlive = agent.keepSocketAlive.bind(agent);
	const reuseSocket = agent.reuseSocket.bind(agent);
	agent.keepSocketAlive = (socket) => {
		const keep: unknown = keepSocketAlive(socket);
		if (keep !== false && socket instanceof Socket)
			socket.setTimeout(Math.min(socket.timeout || 30_000, 30_000));
		return keep;
	};
	agent.reuseSocket = (socket, request) => {
		if (socket instanceof Socket) socket.setTimeout(0);
		reuseSocket(socket, request);
	};
	return agent;
}

const makeS3ConnectionPool = (
	maxFreeSockets: number,
	maxSockets = 50,
	publicHostsOnly = false,
) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const options = {
				keepAlive: true,
				maxSockets,
				maxTotalSockets: Math.max(128, maxSockets * 2),
				maxFreeSockets,
				...(publicHostsOnly && blocksPrivateStorageHosts()
					? { lookup: publicOnlyLookup }
					: {}),
			};
			return {
				httpAgent: boundIdleConnections(new HttpAgent(options)),
				httpsAgent: boundIdleConnections(new HttpsAgent(options)),
			};
		}),
		(pool) =>
			Effect.sync(() => {
				pool.httpAgent.destroy();
				pool.httpsAgent.destroy();
			}),
	);

export const s3ConnectionPool = makeS3ConnectionPool(8, 50, true);
// Desktop source commits copy 256 objects at once in Cap's own bucket, page after page; keeping those
// sockets between pages (they still expire after 30 s idle) avoids re-opening TLS to S3 for every page.
export const defaultBucketS3ConnectionPool = makeS3ConnectionPool(256, 256);
