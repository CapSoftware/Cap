import { mock } from "bun:test";
import * as dns from "node:dns/promises";

process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS ??= "localhost,127.0.0.1";

const FAKE_ADDRESS = "203.0.113.10";

// Tests name hosts that do not exist and run without a network, so names
// resolve to a fixed public address instead of going to DNS.
mock.module("node:dns/promises", () => ({
	...dns,
	lookup: async (hostname: string) => [
		{
			address: hostname === "localhost" ? "127.0.0.1" : FAKE_ADDRESS,
			family: 4,
		},
	],
}));

// Media requests connect to the address a name resolved to and carry the name
// in the Host header. A fetch stub stands in for the network, so it is handed
// such a request under the name it was made for, as the server would see it.
function deliverByName(stub: typeof fetch): typeof fetch {
	const deliver = (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		if (!(input instanceof URL) || input.hostname !== FAKE_ADDRESS)
			return stub(input, init);
		const {
			tls: _tls,
			headers: given,
			...rest
		} = (init ?? {}) as RequestInit & {
			tls?: unknown;
		};
		let host: string | null;
		let headers: RequestInit["headers"];
		if (given instanceof Headers || Array.isArray(given)) {
			const copy = new Headers(given);
			host = copy.get("host");
			copy.delete("host");
			headers = copy;
		} else {
			const { Host, ...others } = (given ?? {}) as Record<string, string>;
			host = Host ?? null;
			headers = Object.keys(others).length > 0 ? others : undefined;
		}
		if (!host) return stub(input, init);
		const named = new URL(input);
		named.host = host;
		return stub(named, { ...rest, ...(headers && { headers }) });
	};
	return Object.assign(deliver, {
		preconnect: stub.preconnect,
	}) as typeof fetch;
}

const nativeFetch = globalThis.fetch;
let currentFetch = nativeFetch;
Object.defineProperty(globalThis, "fetch", {
	configurable: true,
	get: () => currentFetch,
	set: (next: typeof fetch) => {
		currentFetch = next === nativeFetch ? next : deliverByName(next);
	},
});
