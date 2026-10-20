import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { OwnershipPreflightError } from "@cap/utils/recording-ownership-preflight";

export type PreflightFetch = (
	url: string,
	init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

const denied = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 3],
] as const)
	denied.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
] as const)
	denied.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function requirePublicPreflightAddress(address: string) {
	const family = isIP(address);
	if (
		!family ||
		(family === 4
			? denied.check(address, "ipv4")
			: !globalV6.check(address, "ipv6") || denied.check(address, "ipv6"))
	)
		throw new OwnershipPreflightError("INVALID_EVIDENCE");
}

export function requirePreflightOrigin(
	value: string,
	allowedOrigins: readonly string[],
) {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.port ||
		url.username ||
		url.password ||
		url.hash ||
		isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
		!allowedOrigins.includes(url.origin)
	)
		throw new OwnershipPreflightError("INVALID_EVIDENCE");
	for (const origin of allowedOrigins) {
		const allowed = new URL(origin);
		if (
			allowed.origin !== origin ||
			allowed.protocol !== "https:" ||
			allowed.port ||
			allowed.username ||
			allowed.password ||
			isIP(allowed.hostname.replace(/^\[|\]$/g, ""))
		)
			throw new OwnershipPreflightError("INVALID_EVIDENCE");
	}
	return url;
}

export function storagePreflightFetch(
	allowedOrigins: readonly string[],
): PreflightFetch {
	return async (value, init) => {
		const url = requirePreflightOrigin(value, allowedOrigins);
		init.signal.throwIfAborted();
		const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
			const abort = () => reject(new OwnershipPreflightError("INTERRUPTED"));
			init.signal.addEventListener("abort", abort, { once: true });
			lookup(url.hostname, { all: true, verbatim: true })
				.then(resolve, () => reject(new OwnershipPreflightError("UNAVAILABLE")))
				.finally(() => init.signal.removeEventListener("abort", abort));
		});
		init.signal.throwIfAborted();
		if (!addresses.length) throw new OwnershipPreflightError("UNAVAILABLE");
		for (const entry of addresses) requirePublicPreflightAddress(entry.address);
		const address = addresses[0];
		if (!address) throw new OwnershipPreflightError("UNAVAILABLE");
		return new Promise<Response>((resolve, reject) => {
			const req = request(
				url,
				{
					method: "GET",
					headers: init.headers,
					signal: init.signal,
					agent: false,
					family: address.family,
					lookup: (_hostname, _options, callback) =>
						callback(null, address.address, address.family),
				},
				(response) => {
					if (response.statusCode !== 206) {
						response.destroy();
						reject(
							new OwnershipPreflightError(
								response.statusCode === 403 ? "UNAVAILABLE" : "CHANGED",
							),
						);
						return;
					}
					const headers = new Headers();
					for (const [name, values] of Object.entries(response.headers))
						if (values !== undefined)
							headers.set(
								name,
								Array.isArray(values) ? values.join(", ") : values,
							);
					const iterator = response[Symbol.asyncIterator]();
					resolve(
						new Response(
							new ReadableStream<Uint8Array>({
								async pull(controller) {
									try {
										const next = await iterator.next();
										if (next.done) controller.close();
										else controller.enqueue(next.value);
									} catch {
										controller.error(
											new OwnershipPreflightError("UNAVAILABLE"),
										);
									}
								},
								cancel() {
									response.destroy();
								},
							}),
							{ status: 206, headers },
						),
					);
				},
			);
			req.once("error", () =>
				reject(
					new OwnershipPreflightError(
						init.signal.aborted ? "INTERRUPTED" : "UNAVAILABLE",
					),
				),
			);
			req.end();
		});
	};
}
