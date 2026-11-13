import type { LookupAddress } from "node:dns";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// The name below answers with a public address the first time it is asked
// (the check) and a private one after that (the connection). The guard must
// dial only an address it has checked.
const dns = vi.hoisted(() => ({
	checkAnswers: [] as string[],
	connectAnswers: [] as string[],
	checkCalls: 0,
	connectCalls: 0,
}));

vi.mock("node:dns/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:dns/promises")>();
	const lookup = async (hostname: string) => {
		if (hostname !== "rebind.example") return actual.lookup(hostname);
		dns.checkCalls += 1;
		return dns.checkAnswers.map((address) => ({
			address,
			family: address.includes(":") ? 6 : 4,
		}));
	};
	return { ...actual, default: { ...actual, lookup }, lookup };
});

vi.mock("node:dns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:dns")>();
	const lookup = (
		hostname: string,
		options: { all?: boolean } | number | undefined,
		callback: (
			error: NodeJS.ErrnoException | null,
			address: string | LookupAddress[],
			family?: number,
		) => void,
	) => {
		if (hostname !== "rebind.example") {
			return (actual.lookup as (...args: unknown[]) => void)(
				hostname,
				options,
				callback,
			);
		}
		dns.connectCalls += 1;
		const answers = dns.connectAnswers.map((address) => ({
			address,
			family: address.includes(":") ? 6 : 4,
		}));
		const all = typeof options === "object" && options?.all;
		queueMicrotask(() => {
			if (all) callback(null, answers);
			else callback(null, answers[0]?.address ?? "", answers[0]?.family);
		});
	};
	return { ...actual, default: { ...actual, lookup }, lookup };
});

vi.mock("@cap/env", () => ({
	NODE_ENV: "production",
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({}),
}));
vi.mock("@cap/database", () => ({ db: () => ({}) }));

const { sendDeveloperWebhook } = await import(
	"@/lib/developer-webhook-delivery"
);
const { publicOnlyLookup } = await import("@/lib/s3-endpoint-policy");
const { requestPublicOnly } = await import("@/lib/storage-fetch");
const nodeDns = await import("node:dns");

const event = {
	secret: "cws_0123456789abcdefghjkmnpqrstvwx",
	eventId: "evt_1",
	eventType: "video.ready",
	body: JSON.stringify({ id: "evt_1", type: "video.ready" }),
};

let server: Server;
let port: number;
let hits = 0;

beforeAll(async () => {
	server = createServer((_req, res) => {
		hits += 1;
		res.end("internal");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
	hits = 0;
	dns.checkCalls = 0;
	dns.connectCalls = 0;
	dns.checkAnswers = ["93.184.216.34"];
	dns.connectAnswers = ["127.0.0.1"];
});

describe("a name that changes to a private address between check and connect", () => {
	it("passes the check, then is refused at connect and nothing is sent", async () => {
		const result = await sendDeveloperWebhook({
			...event,
			url: "https://rebind.example/cap",
		});
		expect(dns.checkCalls).toBe(1);
		expect(dns.connectCalls).toBe(1);
		expect(result).toMatchObject({ ok: false, errorCode: "private_address" });
		expect(hits).toBe(0);
	});

	it.each([
		["the metadata address", "169.254.169.254"],
		["a unique local v6 address", "fd00:ec2::254"],
		["a mapped v4 loopback", "::ffff:127.0.0.1"],
		["one private address among public ones", "93.184.216.34,10.0.0.5"],
	])("refuses %s at connect", async (_label, answers) => {
		dns.connectAnswers = answers.split(",");
		const result = await sendDeveloperWebhook({
			...event,
			url: "https://rebind.example/cap",
		});
		expect(result).toMatchObject({ ok: false, errorCode: "private_address" });
	});

	it("dials only the address the connection's own lookup checked", async () => {
		// Without the guard, the rebound answer is what gets dialled: this
		// plain request with the same name reaches the local server.
		const unguarded = await new Promise<number>((resolve, reject) => {
			const req = httpRequest(
				{
					host: "rebind.example",
					port,
					path: "/",
					lookup: nodeDns.lookup,
				},
				(res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				},
			);
			req.on("error", reject);
			req.end();
		});
		expect(unguarded).toBe(200);
		expect(hits).toBe(1);

		await expect(
			requestPublicOnly(`http://rebind.example:${port}/`, {
				method: "POST",
				body: "{}",
			}),
		).rejects.toThrow("Refused to connect to private address 127.0.0.1");
		expect(hits).toBe(1);
	});

	it.each([
		["a 6to4 AAAA", ["93.184.216.34", "2002:a00:1::1"]],
		["a Teredo AAAA", ["2001:0:4136:e378::1", "93.184.216.34"]],
		["a documentation address", ["203.0.113.9", "2606:4700::1111"]],
	])(
		"hands the connection only the public address next to %s",
		async (_label, answers) => {
			dns.connectAnswers = answers;
			const result = await new Promise<{
				error: NodeJS.ErrnoException | null;
				address: unknown;
			}>((resolve) =>
				publicOnlyLookup("rebind.example", { all: true }, (error, address) =>
					resolve({ error, address }),
				),
			);
			expect(result.error).toBeNull();
			const dialled = (result.address as { address: string }[]).map(
				(entry) => entry.address,
			);
			expect(dialled).toEqual(
				answers.filter((address) =>
					["93.184.216.34", "2606:4700::1111"].includes(address),
				),
			);
		},
	);

	it("refuses a name whose only addresses are reserved", async () => {
		dns.connectAnswers = ["2002:a00:1::1", "192.0.2.1"];
		const error = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
			publicOnlyLookup("rebind.example", { all: true }, (lookupError) =>
				resolve(lookupError),
			),
		);
		expect(error?.code).toBe("ECONNREFUSED");
	});

	it("still refuses a public address next to a NAT64 form of a private one", async () => {
		dns.connectAnswers = ["93.184.216.34", "64:ff9b::a00:1"];
		const error = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
			publicOnlyLookup("rebind.example", { all: true }, (lookupError) =>
				resolve(lookupError),
			),
		);
		expect(error?.code).toBe("ECONNREFUSED");
	});

	it("checks every address the lookup returns, not only the first", async () => {
		dns.connectAnswers = ["93.184.216.34", "127.0.0.1"];
		const error = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
			publicOnlyLookup("rebind.example", { all: true }, (lookupError) =>
				resolve(lookupError),
			),
		);
		expect(error?.code).toBe("ECONNREFUSED");
	});
});
