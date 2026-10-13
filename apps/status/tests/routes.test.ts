import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { GET as collect } from "../app/api/cron/check/route";
import { GET as readStatus } from "../app/api/status/route";
import { SERVICES } from "../lib/services";
import { CHECK_INTERVAL_MS, emptyState } from "../lib/state";
import { LOCK_KEY, STATE_KEY } from "../lib/store";
import deployment from "../vercel.json";

const values = new Map<string, string>();
const realFetch = globalThis.fetch;
let storageCommands = 0;
const variableNames = [
	"UPSTASH_REDIS_REST_URL",
	"UPSTASH_REDIS_REST_TOKEN",
	"CRON_SECRET",
	"VERCEL_ENV",
	...SERVICES.map((service) => service.env),
];
const previousEnvironment = Object.fromEntries(
	variableNames.map((key) => [key, process.env[key]]),
);
let probeCalls = 0;
let failStorage = false;
let stealLease = false;

function command(args: string[]) {
	storageCommands++;
	const [name, key, value] = args;
	if (name.toUpperCase() === "SET") {
		if (args.some((arg) => arg.toUpperCase() === "NX") && values.has(key))
			return null;
		values.set(key, value);
		return "OK";
	}
	if (name.toUpperCase() === "GET") return values.get(key) ?? null;
	if (name.toUpperCase() === "EVAL") {
		const count = Number(args[2]);
		const keys = args.slice(3, 3 + count);
		const parameters = args.slice(3 + count);
		if (values.get(keys[0]) !== parameters[0]) return 0;
		if (count === 2) values.set(keys[1], parameters[1]);
		values.delete(keys[0]);
		return 1;
	}
	throw new Error(`Unexpected Redis command: ${name}`);
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		if (failStorage)
			return Response.json({ error: "unavailable" }, { status: 503 });
		const args = await request.json();
		return Response.json(
			Array.isArray(args[0])
				? args.map((entry: string[]) => ({ result: command(entry) }))
				: { result: command(args) },
		);
	},
});

beforeEach(() => {
	values.clear();
	storageCommands = 0;
	probeCalls = 0;
	failStorage = false;
	stealLease = false;
	process.env.UPSTASH_REDIS_REST_URL = server.url.toString();
	process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
	process.env.CRON_SECRET = "test-secret";
	process.env.VERCEL_ENV = "production";
	for (const service of SERVICES)
		process.env[service.env] = `https://status-fixture.example/${service.id}`;
	globalThis.fetch = (async (input, options) => {
		const url = new URL(String(input));
		if (url.hostname !== "status-fixture.example")
			return realFetch(input, options);
		probeCalls++;
		await new Promise((resolve) => setTimeout(resolve, 5));
		if (stealLease) values.set(LOCK_KEY, "another-owner");
		if (url.pathname === "/api")
			return Response.json({ google: { id: "google", type: "oauth" } });
		if (url.pathname === "/media") return Response.json({ status: "ok" });
		if (url.pathname === "/render")
			return Response.json({ ok: true, workers: 2, slots: 4 });
		return new Response(null, { status: 200 });
	}) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = realFetch;
	server.stop(true);
	for (const key of variableNames) {
		if (previousEnvironment[key] === undefined) delete process.env[key];
		else process.env[key] = previousEnvironment[key];
	}
});

const authorizedRequest = () =>
	new Request("https://status.example/api/cron/check", {
		headers: { authorization: "Bearer test-secret" },
	});

describe("scheduler → storage → public API", () => {
	test("rejects unauthorized or missing-secret requests before doing work", async () => {
		expect(
			(await collect(new Request("https://status.example/api/cron/check")))
				.status,
		).toBe(401);
		delete process.env.CRON_SECRET;
		expect((await collect(authorizedRequest())).status).toBe(401);
		expect(probeCalls).toBe(0);
		expect(values.size).toBe(0);
	});

	test("rejects cache-busting queries before accessing storage", async () => {
		for (const query of [
			"?x=one",
			"?x=two",
			"?cache=false&timestamp=123",
			"?%78=encoded",
		]) {
			const response = await readStatus(
				new Request(`https://status.example/api/status${query}`),
			);
			expect(response.status).toBe(400);
			expect(response.headers.get("cache-control")).toBe("no-store");
		}
		expect(storageCommands).toBe(0);
		expect(probeCalls).toBe(0);
	});

	test("previews never probe production services", async () => {
		process.env.VERCEL_ENV = "preview";
		expect(await (await collect(authorizedRequest())).json()).toEqual({
			skipped: "Preview deployment",
		});
		expect(probeCalls).toBe(0);
	});

	test("persists real observations and serves them without running new probes", async () => {
		expect((await collect(authorizedRequest())).status).toBe(200);
		expect(probeCalls).toBe(6);
		expect(values.has(STATE_KEY)).toBe(true);
		expect(values.has(LOCK_KEY)).toBe(false);
		const response = await readStatus(
			new Request("https://status.example/api/status"),
		);
		const snapshot = await response.json();
		expect(
			snapshot.services.every(
				(service: { status: string }) => service.status === "operational",
			),
		).toBe(true);
		expect(JSON.stringify(snapshot)).not.toContain("status-fixture.example");
		expect(JSON.stringify(snapshot)).not.toContain("test-token");
		expect(response.headers.get("cache-control")).toContain("s-maxage=30");
		expect(probeCalls).toBe(6);
		expect(await (await collect(authorizedRequest())).json()).toEqual({
			skipped: "Check interval already sampled",
		});
		expect(probeCalls).toBe(6);
	});

	test("limits collection to the configured five-minute interval", async () => {
		expect(deployment.crons[0].schedule).toBe("*/5 * * * *");
		const start =
			Math.floor(Date.now() / CHECK_INTERVAL_MS) * CHECK_INTERVAL_MS;
		values.set(
			STATE_KEY,
			JSON.stringify({
				...emptyState(),
				checkedAt: new Date(start).toISOString(),
			}),
		);
		const clock = spyOn(Date, "now").mockReturnValue(start + 2 * 60_000);
		try {
			expect(await (await collect(authorizedRequest())).json()).toEqual({
				skipped: "Check interval already sampled",
			});
			expect(probeCalls).toBe(0);
			clock.mockReturnValue(start + CHECK_INTERVAL_MS);
			expect((await collect(authorizedRequest())).status).toBe(200);
			expect(probeCalls).toBe(6);
		} finally {
			clock.mockRestore();
		}
	});

	test("overlapping invocations perform a single collection", async () => {
		const responses = await Promise.all([
			collect(authorizedRequest()),
			collect(authorizedRequest()),
		]);
		expect(probeCalls).toBe(6);
		expect(
			(await Promise.all(responses.map((response) => response.json()))).some(
				(body) => body.skipped === "Check already running",
			),
		).toBe(true);
	});

	test("a lost lease cannot commit or remove a newer owner's lock", async () => {
		stealLease = true;
		expect((await collect(authorizedRequest())).status).toBe(503);
		expect(values.has(STATE_KEY)).toBe(false);
		expect(values.get(LOCK_KEY)).toBe("another-owner");
	});

	test("storage outages return unknown data without cached success", async () => {
		failStorage = true;
		const response = await readStatus(
			new Request("https://status.example/api/status"),
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(
			(await response.json()).services.every(
				(service: { status: string }) => service.status === "unknown",
			),
		).toBe(true);
		expect(probeCalls).toBe(0);
	});
});
