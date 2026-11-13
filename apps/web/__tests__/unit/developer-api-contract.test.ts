import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	keyRows: [] as { appId: string; ownerId?: string; environment?: string }[],
	hashKey: vi.fn(),
	accounts: [] as { balanceMicroCredits: number }[],
	videoStats: [] as Record<string, unknown>[],
	storedVideos: [] as Record<string, unknown>[],
	selected: [] as Record<string, unknown>[],
	createVideo: vi.fn(),
	initiate: vi.fn(),
	billing: vi.fn(),
	listTranscripts: vi.fn(),
	firewall: vi.fn(),
}));

vi.mock("@vercel/firewall", () => ({ checkRateLimit: mocks.firewall }));

vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	const rowsFor = (table: unknown, fields?: Record<string, unknown>) => {
		if (table === schema.developerApiKeys) return mocks.keyRows;
		if (table === schema.developerCreditAccounts) return mocks.accounts;
		if (table === schema.developerVideos) {
			return fields && "createdVideos" in fields
				? mocks.videoStats
				: mocks.storedVideos;
		}
		return [];
	};
	const select = (fields?: Record<string, unknown>) => ({
		from: (table: unknown) => {
			if (fields) mocks.selected.push(fields);
			const where = () =>
				Object.assign(Promise.resolve(rowsFor(table, fields)), {
					limit: async () => rowsFor(table, fields),
					groupBy: async () => rowsFor(table, fields),
				});
			const query = { innerJoin: () => query, where };
			return query;
		},
	});
	const update = () => ({ set: () => ({ where: async () => {} }) });
	return { db: () => ({ select, update }) };
});
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@cap/database/auth/domain-utils", () => ({
	isBlockedAccountEmail: () => false,
}));
vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	serverEnv: () => ({
		WEB_URL: "https://cap.so",
		NEXTAUTH_SECRET: "unit-test-signing-secret",
	}),
}));
vi.mock("@/lib/developer-key-hash", () => ({ hashKey: mocks.hashKey }));
vi.mock("@/lib/developer-video-start", () => ({
	redriveDeveloperVideoProcessing: vi.fn(),
}));
vi.mock("@/lib/developer-transcript-store", () => ({
	listTranscripts: mocks.listTranscripts,
	isTranscriptIdempotencyKey: () => true,
}));
vi.mock("@/lib/developer-transcript-usage", () => ({
	getSpeechUsage: async () => ({
		balanceMicroCredits: mocks.accounts[0]?.balanceMicroCredits ?? 0,
		availableMicroCredits: 0,
		heldMicroCredits: 0,
		speech: {
			periodStart: "2026-11-01T00:00:00.000Z",
			seconds: 0,
			microCredits: 0,
			transcripts: 0,
		},
	}),
}));
vi.mock("@/lib/infra-standing", async (original) => ({
	...(await original<typeof import("@/lib/infra-standing")>()),
	getInfraBilling: mocks.billing,
	infraBillingJson: (billing: Record<string, unknown>) => billing,
}));
vi.mock("@/lib/infra-video-upload", () => ({
	MAX_UPLOAD_BYTES: 36_000_000_000,
	openUpload: vi.fn(),
	createInfraVideo: mocks.createVideo,
	initiateInfraUpload: mocks.initiate,
	presignInfraUploadParts: vi.fn(),
	completeInfraUpload: vi.fn(),
	abortInfraUpload: vi.fn(),
}));

import * as sdk from "@/app/api/developer/sdk/v1/[...route]/route";
import * as rest from "@/app/api/developer/v1/[...route]/route";
import { developerOpenApiSpec } from "@/lib/developer-openapi";
import {
	MICRO_CREDITS_PER_DOLLAR,
	SPEECH_DOLLARS_PER_HOUR,
	UPLOAD_ADMISSION_DAYS,
	uploadAdmissionMicroCredits,
} from "@/lib/developer-pricing";
import {
	DEVELOPER_KEY_REQUESTS_PER_MINUTE,
	DEVELOPER_OWNER_REQUESTS_PER_MINUTE,
	DEVELOPER_UPLOAD_TOKEN_REQUESTS_PER_MINUTE,
} from "@/lib/developer-rate-limits";
import { createDeveloperUploadToken } from "@/lib/developer-upload-token";
import {
	INFRA_RESOLUTION_TIERS,
	INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
} from "@/lib/infra-pricing";
import { getAppStorage } from "@/lib/infra-storage";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

const ORIGIN = "https://cap.so";
let keySerial = 0;
let ownerSerial = 0;
const freshKey = (prefix: "csk" | "cpk" | "cut") =>
	prefix === "cut"
		? createDeveloperUploadToken({
				appId: "app-1",
				videoId: `video-${++keySerial}`,
				expiresAt: Date.now() + 60_000,
				corsOrigin: null,
			})
		: `${prefix}_key_${++keySerial}`;

function call(
	routes: Partial<Record<Method, (request: Request) => unknown>>,
	method: Method,
	path: string,
	init: { key?: string; headers?: Record<string, string>; body?: string } = {},
) {
	const handler = routes[method];
	if (!handler) throw new Error(`${method} is not exported by the route`);
	const headers = {
		...(init.key ? { Authorization: `Bearer ${init.key}` } : {}),
		...init.headers,
	};
	return handler(
		new Request(`${ORIGIN}${path}`, { method, headers, body: init.body }),
	) as Promise<Response>;
}

const getUsage = (key: string, headers?: Record<string, string>) =>
	call(rest, "GET", "/api/developer/v1/usage", { key, headers });

const rateLimit = (response: Response) => ({
	limit: response.headers.get("X-RateLimit-Limit"),
	remaining: response.headers.get("X-RateLimit-Remaining"),
	reset: response.headers.get("X-RateLimit-Reset"),
	retryAfter: response.headers.get("Retry-After"),
});

const billingOf = async (billing: Record<string, unknown>) => ({
	...billing,
	stored: (await getAppStorage("app-1")).stored,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hashKey.mockImplementation(async (key: string) => `hash:${key}`);
	mocks.keyRows = [
		{
			appId: "app-1",
			ownerId: `owner-${++ownerSerial}`,
			environment: "development",
		},
	];
	mocks.accounts = [{ balanceMicroCredits: 4_532_000 }];
	mocks.videoStats = [{ createdVideos: 5, uploadedVideos: 4 }];
	mocks.storedVideos = [
		{
			appId: "app-1",
			width: 1920,
			height: 1080,
			status: "ready",
			maxResolutionTier: "1080p",
			seconds: 750,
			count: 3,
		},
		{
			appId: "app-1",
			width: 1920,
			height: 1080,
			status: "errored",
			maxResolutionTier: "1080p",
			seconds: 345.21,
			count: 1,
		},
	];
	mocks.selected = [];
	mocks.billing.mockImplementation(() =>
		billingOf({ standing: { state: "active" } }),
	);
	mocks.createVideo.mockResolvedValue({
		status: 200,
		body: { videoId: "video-1" },
	});
	mocks.initiate.mockResolvedValue({ status: 200, body: { uploadId: "u-1" } });
	mocks.listTranscripts.mockResolvedValue({ transcripts: [], hasMore: false });
	mocks.firewall.mockResolvedValue({ rateLimited: false });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("rate limit headers", () => {
	it("counts down on every response and resets with the window", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
		const key = freshKey("csk");

		const first = await getUsage(key);
		expect(first.status).toBe(200);
		expect(rateLimit(first)).toEqual({
			limit: "60",
			remaining: "59",
			reset: "60",
			retryAfter: null,
		});

		vi.advanceTimersByTime(20_500);
		const second = await getUsage(key);
		expect(rateLimit(second)).toMatchObject({ remaining: "58", reset: "40" });

		for (let request = 3; request <= 60; request++) await getUsage(key);
		vi.advanceTimersByTime(4_500);
		const limited = await getUsage(key);
		expect(limited.status).toBe(429);
		expect(rateLimit(limited)).toEqual({
			limit: "60",
			remaining: "0",
			reset: "35",
			retryAfter: "35",
		});
		expect(await limited.json()).toMatchObject({ code: "rate_limited" });

		vi.advanceTimersByTime(34_999);
		expect((await getUsage(key)).status).toBe(429);

		vi.advanceTimersByTime(2);
		const afterWait = await getUsage(key);
		expect(afterWait.status).toBe(200);
		expect(rateLimit(afterWait)).toMatchObject({
			remaining: "59",
			reset: "60",
		});
	});

	it("keeps Retry-After equal to the time left as the window runs down", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
		const key = freshKey("csk");
		for (let request = 1; request <= 60; request++) await getUsage(key);

		for (const [elapsed, expected] of [
			[0, "60"],
			[1, "60"],
			[1_000, "59"],
			[59_000, "1"],
			[59_999, "1"],
		] as const) {
			vi.setSystemTime(new Date(Date.parse("2026-11-12T10:00:00Z") + elapsed));
			const limited = await getUsage(key);
			expect(limited.status).toBe(429);
			expect(rateLimit(limited).retryAfter).toBe(expected);
		}
	});

	it("counts one key once however the Authorization scheme is written", async () => {
		const key = freshKey("csk");

		const upper = await getUsage(key);
		const lower = await call(rest, "GET", "/api/developer/v1/usage", {
			headers: { Authorization: `bearer ${key}` },
		});
		const spaced = await call(rest, "GET", "/api/developer/v1/usage", {
			headers: { Authorization: `Bearer   ${key}` },
		});
		const other = await getUsage(freshKey("csk"));

		expect(rateLimit(upper).remaining).toBe("59");
		expect(rateLimit(lower).remaining).toBe("58");
		expect(rateLimit(spaced).remaining).toBe("57");
		expect(rateLimit(other).remaining).toBe("59");
	});

	it("carries the headers on errors too, and spends none of a key's budget on a key that was not accepted", async () => {
		const key = freshKey("csk");
		const accepted = mocks.keyRows;
		mocks.keyRows = [];
		const unauthorized = await getUsage(key);
		mocks.keyRows = accepted;
		const notFound = await call(rest, "GET", "/api/developer/v1/nope", { key });
		const wrongMethod = await call(rest, "POST", "/api/developer/v1/usage", {
			key,
		});
		mocks.billing.mockRejectedValue(new Error("database is down"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const failed = await getUsage(key);

		expect(
			[unauthorized, notFound, wrongMethod, failed].map((response) => [
				response.status,
				rateLimit(response).remaining,
			]),
		).toEqual([
			[401, null],
			[404, "59"],
			[405, "58"],
			[500, "57"],
		]);
	});

	it("lets a browser read the headers across origins", async () => {
		const response = await call(
			sdk,
			"POST",
			"/api/developer/sdk/v1/upload/multipart/initiate",
			{
				key: freshKey("cut"),
				headers: {
					Origin: "https://app.example",
					"Content-Type": "application/json",
				},
				body: "{}",
			},
		);

		expect(response.status).toBe(200);
		expect(mocks.initiate).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ appId: "app-1" }),
		);
		expect(
			response.headers
				.get("Access-Control-Expose-Headers")
				?.split(",")
				.map((name) => name.trim())
				.sort(),
		).toEqual([
			"Retry-After",
			"X-RateLimit-Limit",
			"X-RateLimit-Remaining",
			"X-RateLimit-Reset",
		]);
	});
});

describe("rate limit shared across servers", () => {
	const initiate = (key: string, headers: Record<string, string> = {}) =>
		call(sdk, "POST", "/api/developer/sdk/v1/upload/multipart/initiate", {
			key,
			headers: { "Content-Type": "application/json", ...headers },
			body: "{}",
		});
	const firewallCalls = () =>
		mocks.firewall.mock.calls.map(([ruleId, options]) => ({
			ruleId: ruleId as string,
			key: options.rateLimitKey as string,
			request: options.request as Request,
		}));

	beforeEach(() => {
		vi.stubEnv("NODE_ENV", "production");
	});

	it("rejects when the shared rule says so, whatever this server has counted", async () => {
		mocks.firewall.mockResolvedValue({ rateLimited: true });

		const limited = await getUsage(freshKey("csk"));

		expect(limited.status).toBe(429);
		expect(rateLimit(limited)).toEqual({
			limit: "60",
			remaining: "0",
			reset: "60",
			retryAfter: "60",
		});
		expect(await limited.json()).toMatchObject({
			error: "Rate limit exceeded",
			code: "rate_limited",
			hint: "Wait for the Retry-After seconds, then retry. Each key allows 60 requests per minute.",
		});
		expect(mocks.billing).not.toHaveBeenCalled();
	});

	it("rejects an upload token the same way and lets the page read why", async () => {
		mocks.firewall.mockResolvedValue({ rateLimited: true });

		const limited = await initiate(freshKey("cut"), {
			Origin: "https://app.example",
		});

		expect(limited.status).toBe(429);
		expect(rateLimit(limited)).toEqual({
			limit: "1200",
			remaining: "0",
			reset: "60",
			retryAfter: "60",
		});
		expect(await limited.json()).toMatchObject({
			code: "rate_limited",
			hint: "Wait for the Retry-After seconds, then retry. Each upload token allows 1200 requests per minute.",
		});
		expect(limited.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(limited.headers.get("Access-Control-Expose-Headers")).toContain(
			"Retry-After",
		);
		expect(mocks.initiate).not.toHaveBeenCalled();
	});

	it("lets the shared rule overrule a count this server kept alone", async () => {
		const key = freshKey("csk");
		for (let request = 1; request <= 60; request++) await getUsage(key);

		const allowed = await getUsage(key);

		expect(allowed.status).toBe(200);
		expect(rateLimit(allowed)).toMatchObject({
			limit: "60",
			remaining: "0",
			retryAfter: null,
		});
	});

	it("asks one rule per kind of credential, keyed on a hash of it", async () => {
		const secret = freshKey("csk");
		const token = freshKey("cut");

		await getUsage(secret);
		await getUsage(secret, { Authorization: `bearer   ${secret}` });
		await getUsage(freshKey("csk"));
		await initiate(token);

		const [first, again, other, upload] = firewallCalls().filter(
			(asked) => asked.ruleId !== "rl_developer_api_owner",
		);
		expect([first, again, other, upload].map((asked) => asked?.ruleId)).toEqual(
			[
				"rl_developer_api_key",
				"rl_developer_api_key",
				"rl_developer_api_key",
				"rl_developer_upload_token",
			],
		);
		expect(first?.key).toMatch(/^[0-9a-f]{64}$/);
		expect(again?.key).toBe(first?.key);
		expect(other?.key).not.toBe(first?.key);
		expect(upload?.key).toMatch(/^[0-9a-f]{64}$/);
		for (const asked of firewallCalls()) {
			for (const credential of [secret, token]) {
				expect(asked.key).not.toContain(credential);
				expect(JSON.stringify([...asked.request.headers])).not.toContain(
					credential,
				);
			}
		}
	});

	it.each([
		["the rule does not exist yet", { rateLimited: false, error: "not-found" }],
		["the firewall cannot be reached", new Error("fetch failed")],
	])("counts on this server alone while %s", async (_label, outcome) => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
		if (outcome instanceof Error) mocks.firewall.mockRejectedValue(outcome);
		else mocks.firewall.mockResolvedValue(outcome);
		const key = freshKey("csk");

		const first = await getUsage(key);
		expect(rateLimit(first)).toEqual({
			limit: "60",
			remaining: "59",
			reset: "60",
			retryAfter: null,
		});
		for (let request = 2; request <= 60; request++) {
			expect((await getUsage(key)).status).toBe(200);
		}
		vi.advanceTimersByTime(25_000);
		const limited = await getUsage(key);

		expect(limited.status).toBe(429);
		expect(rateLimit(limited)).toEqual({
			limit: "60",
			remaining: "0",
			reset: "35",
			retryAfter: "35",
		});
	});
});

describe("one account's keys share a budget", () => {
	const ownedBy = (ownerId: string) => {
		mocks.keyRows = [{ appId: "app-1", ownerId }];
	};

	it("allows 300 requests a minute across every key of an account, then answers 429", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
		ownedBy("owner-shared");
		const keys = Array.from({ length: 6 }, () => freshKey("csk"));

		for (const key of keys) {
			for (let request = 1; request <= 50; request++) {
				expect((await getUsage(key)).status).toBe(200);
			}
		}
		vi.advanceTimersByTime(20_000);
		const limited = await getUsage(freshKey("csk"));

		expect(limited.status).toBe(429);
		expect(rateLimit(limited)).toEqual({
			limit: "60",
			remaining: "0",
			reset: "40",
			retryAfter: "40",
		});
		expect(await limited.json()).toMatchObject({
			code: "rate_limited",
			hint: "Wait for the Retry-After seconds, then retry. Each account, across all of its keys, allows 300 requests per minute.",
		});
		expect(mocks.billing).toHaveBeenCalledTimes(300);

		ownedBy("owner-other");
		expect((await getUsage(freshKey("csk"))).status).toBe(200);

		ownedBy("owner-shared");
		vi.advanceTimersByTime(40_001);
		expect((await getUsage(keys[0] as string)).status).toBe(200);
	});

	it("takes the account from the key lookup, with no query of its own", async () => {
		const response = await call(rest, "GET", "/api/developer/v1/nope", {
			key: freshKey("csk"),
		});

		expect(response.status).toBe(404);
		expect(mocks.selected).toHaveLength(1);
		expect(Object.keys(mocks.selected[0] ?? {}).sort()).toEqual([
			"appId",
			"ownerId",
		]);
		expect(mocks.hashKey).toHaveBeenCalledTimes(1);
	});

	it("asks the shared rule about the account by its id", async () => {
		vi.stubEnv("NODE_ENV", "production");
		ownedBy("owner-asked");

		await getUsage(freshKey("csk"));

		const asked = mocks.firewall.mock.calls.map(([ruleId, options]) => [
			ruleId,
			options.rateLimitKey,
		]);
		expect(asked).toContainEqual(["rl_developer_api_owner", "owner-asked"]);
		expect(asked).toHaveLength(2);
	});

	it("rejects when the shared rule for the account says so", async () => {
		vi.stubEnv("NODE_ENV", "production");
		ownedBy("owner-limited");
		mocks.firewall.mockImplementation(async (ruleId: string) => ({
			rateLimited: ruleId === "rl_developer_api_owner",
		}));

		const limited = await getUsage(freshKey("csk"));

		expect(limited.status).toBe(429);
		expect(rateLimit(limited)).toMatchObject({
			limit: "60",
			remaining: "0",
			retryAfter: "60",
		});
		expect(mocks.billing).not.toHaveBeenCalled();
	});
});

describe("credentials that are not accepted", () => {
	const from = (address: string) => ({ "x-forwarded-for": address });

	it.each([
		["no credential", undefined],
		["a credential with no prefix", "Bearer not-a-key"],
		["a public key", "Bearer cpk_public_1"],
		["an oversized key", `Bearer csk_${"a".repeat(200)}`],
		["a key with characters no key has", "Bearer csk_abc!def"],
	] as const)(
		"refuses %s without hashing, looking up or counting anything",
		async (_label, authorization) => {
			vi.stubEnv("NODE_ENV", "production");

			const response = await call(rest, "GET", "/api/developer/v1/usage", {
				headers: authorization ? { Authorization: authorization } : {},
			});

			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({
				code: "invalid_secret_key",
			});
			expect(rateLimit(response)).toEqual({
				limit: null,
				remaining: null,
				reset: null,
				retryAfter: null,
			});
			expect(mocks.hashKey).not.toHaveBeenCalled();
			expect(mocks.selected).toHaveLength(0);
			expect(mocks.firewall).not.toHaveBeenCalled();
		},
	);

	it("answers an unknown key 401 on any path, and stops looking keys up for an address after 30 of them in a minute", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
		mocks.keyRows = [];
		const address = from("203.0.113.9");

		for (let attempt = 1; attempt <= 30; attempt++) {
			const refused = await call(rest, "GET", "/api/developer/v1/nope", {
				key: freshKey("csk"),
				headers: address,
			});
			expect(refused.status).toBe(401);
		}
		expect(mocks.hashKey).toHaveBeenCalledTimes(30);

		const limited = await getUsage(freshKey("csk"), address);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("Retry-After")).toBe("60");
		expect(await limited.json()).toMatchObject({
			code: "rate_limited",
			error: "Too many requests with a key or token that was not accepted",
		});
		expect(mocks.hashKey).toHaveBeenCalledTimes(31);

		mocks.hashKey.mockClear();
		mocks.selected = [];
		for (let attempt = 1; attempt <= 50; attempt++) {
			expect((await getUsage(freshKey("csk"), address)).status).toBe(429);
		}
		expect(mocks.hashKey).not.toHaveBeenCalled();
		expect(mocks.selected).toHaveLength(0);

		const elsewhere = await getUsage(freshKey("csk"), from("198.51.100.4"));
		expect(elsewhere.status).toBe(401);

		vi.advanceTimersByTime(60_001);
		expect((await getUsage(freshKey("csk"), address)).status).toBe(401);
	});

	it("keeps a key it accepted in the last minute working from an address that is being refused", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T11:00:00Z"));
		const address = from("203.0.113.77");
		const accepted = mocks.keyRows;
		const customer = freshKey("csk");
		expect((await getUsage(customer, address)).status).toBe(200);

		mocks.keyRows = [];
		for (let attempt = 1; attempt <= 31; attempt++) {
			await getUsage(freshKey("csk"), address);
		}
		expect((await getUsage(freshKey("csk"), address)).status).toBe(429);

		mocks.keyRows = accepted;
		expect((await getUsage(customer, address)).status).toBe(200);
	});

	it("counts by the address the platform reports, not one the caller writes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
		vi.stubEnv("VERCEL", "1");
		mocks.keyRows = [];
		const statuses: number[] = [];

		for (let attempt = 1; attempt <= 32; attempt++) {
			const response = await getUsage(freshKey("csk"), {
				"x-real-ip": "203.0.113.200",
				"x-forwarded-for": `10.0.0.${attempt}, 203.0.113.200`,
				"x-client-ip": `10.9.9.${attempt}`,
			});
			statuses.push(response.status);
		}

		expect(statuses.slice(0, 30)).toEqual(Array(30).fill(401));
		expect(statuses.slice(30)).toEqual([429, 429]);
	});

	it("asks the shared rule about the address, sending it no credential", async () => {
		vi.stubEnv("NODE_ENV", "production");
		mocks.keyRows = [];
		const key = freshKey("csk");

		const refused = await getUsage(key, { "x-real-ip": "203.0.113.50" });

		expect(refused.status).toBe(401);
		expect(mocks.firewall).toHaveBeenCalledTimes(1);
		const [ruleId, options] = mocks.firewall.mock.calls[0] ?? [];
		expect(ruleId).toBe("rl_developer_auth_failure");
		expect(options.rateLimitKey).toBeUndefined();
		expect(options.request.headers.get("x-real-ip")).toBe("203.0.113.50");
		expect(JSON.stringify([...options.request.headers])).not.toContain(key);
	});

	it("answers 429 as soon as the shared rule says the address has sent too many", async () => {
		vi.stubEnv("NODE_ENV", "production");
		mocks.keyRows = [];
		mocks.firewall.mockResolvedValue({ rateLimited: true });
		const address = { "x-real-ip": "203.0.113.60" };

		expect((await getUsage(freshKey("csk"), address)).status).toBe(429);
		mocks.hashKey.mockClear();
		mocks.firewall.mockClear();
		expect((await getUsage(freshKey("csk"), address)).status).toBe(429);
		expect(mocks.hashKey).not.toHaveBeenCalled();
		expect(mocks.firewall).not.toHaveBeenCalled();
	});

	it("does not count an upload token that is malformed, expired or simply absent", async () => {
		vi.stubEnv("NODE_ENV", "production");
		const send = (authorization?: string) =>
			call(sdk, "POST", "/api/developer/sdk/v1/upload/multipart/initiate", {
				headers: {
					"Content-Type": "application/json",
					...(authorization ? { Authorization: authorization } : {}),
				},
				body: "{}",
			});
		const expired = createDeveloperUploadToken({
			appId: "app-1",
			videoId: "video-expired",
			expiresAt: Date.now() - 1,
			corsOrigin: null,
		});

		const answers = [
			await send(),
			await send("Bearer csk_secret_on_the_wrong_route"),
			await send("Bearer cpk_public_1"),
			await send(`Bearer ${expired}`),
		];

		expect(answers.map((response) => response.status)).toEqual([
			401, 401, 403, 401,
		]);
		expect(mocks.firewall).not.toHaveBeenCalled();
		for (const response of answers) {
			expect(rateLimit(response).limit).toBeNull();
		}
	});

	it("counts a forged upload token against the address and still words the refusal as before", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T13:00:00Z"));
		const forged = () =>
			call(sdk, "POST", "/api/developer/sdk/v1/upload/multipart/initiate", {
				key: `${freshKey("cut")}x`,
				headers: {
					"Content-Type": "application/json",
					"x-forwarded-for": "203.0.113.120",
				},
				body: "{}",
			});

		const first = await forged();
		expect(first.status).toBe(401);
		expect(await first.json()).toMatchObject({ code: "invalid_upload_token" });
		for (let attempt = 2; attempt <= 30; attempt++) await forged();

		const limited = await forged();
		expect(limited.status).toBe(429);
		expect(limited.headers.get("Access-Control-Allow-Origin")).toBe("*");

		const genuine = await call(
			sdk,
			"POST",
			"/api/developer/sdk/v1/upload/multipart/initiate",
			{
				key: freshKey("cut"),
				headers: {
					"Content-Type": "application/json",
					"x-forwarded-for": "203.0.113.120",
				},
				body: "{}",
			},
		);
		expect(genuine.status).toBe(200);
	});
});

describe("upload tokens have their own budget", () => {
	const initiate = (key: string) =>
		call(sdk, "POST", "/api/developer/sdk/v1/upload/multipart/initiate", {
			key,
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});

	it("allows 1200 requests a minute on one token, then answers 429", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
		const token = freshKey("cut");

		const first = await initiate(token);
		expect(first.status).toBe(200);
		expect(rateLimit(first)).toEqual({
			limit: "1200",
			remaining: "1199",
			reset: "60",
			retryAfter: null,
		});
		for (let request = 2; request <= 1200; request++) await initiate(token);
		vi.advanceTimersByTime(10_000);
		const limited = await initiate(token);

		expect(limited.status).toBe(429);
		expect(rateLimit(limited)).toEqual({
			limit: "1200",
			remaining: "0",
			reset: "50",
			retryAfter: "50",
		});
		expect(rateLimit(await initiate(freshKey("cut"))).remaining).toBe("1199");
	});

	it("keeps the secret key at 60 a minute", async () => {
		expect(rateLimit(await getUsage(freshKey("csk"))).limit).toBe("60");
	});

	it("documents the limits the limiter applies", async () => {
		const key = rateLimit(await getUsage(freshKey("csk"))).limit;
		const token = rateLimit(await initiate(freshKey("cut"))).limit;
		const docs = readFileSync(
			join(process.cwd(), "content/docs/api/rest-api.mdx"),
			"utf8",
		);
		const spec = developerOpenApiSpec(ORIGIN);

		expect(key).toBe(String(DEVELOPER_KEY_REQUESTS_PER_MINUTE));
		expect(token).toBe(String(DEVELOPER_UPLOAD_TOKEN_REQUESTS_PER_MINUTE));
		expect(docs).toContain(`A secret key allows ${key} requests per minute`);
		expect(docs).toContain(
			`An upload token allows ${Number(token).toLocaleString("en-US")} requests per minute`,
		);
		expect(spec.info.description).toContain(
			`A secret key is limited to ${key} requests per minute`,
		);
		expect(spec.info.description).toContain(
			`each upload token to ${token} requests per minute`,
		);
		expect(docs).toContain(
			`All the keys of one account together allow ${DEVELOPER_OWNER_REQUESTS_PER_MINUTE} requests per minute`,
		);
		expect(spec.info.description).toContain(
			`all the keys of one account together to ${DEVELOPER_OWNER_REQUESTS_PER_MINUTE}`,
		);
	});
});

describe("browser access", () => {
	const ORIGIN_HEADERS = { Origin: "https://app.example" };
	const PREFLIGHT_HEADERS = {
		...ORIGIN_HEADERS,
		"Access-Control-Request-Method": "GET",
		"Access-Control-Request-Headers": "authorization,content-type",
	};
	const corsHeaders = (response: Response) =>
		[...response.headers.keys()].filter((name) =>
			name.toLowerCase().startsWith("access-control-"),
		);

	it("sends no CORS header on any answer of the secret-key API", async () => {
		const key = freshKey("csk");
		const from = (method: Method, path: string, withKey = true) =>
			call(rest, method, path, {
				key: withKey ? key : undefined,
				headers: ORIGIN_HEADERS,
			});

		const answers = [
			await from("GET", "/api/developer/v1/usage"),
			await from("GET", "/api/developer/v1/videos?limit=0"),
			await from("GET", "/api/developer/v1/videos?userId="),
			await from("GET", "/api/developer/v1/usage", false),
			await from("GET", "/api/developer/v1/nope"),
			await from("POST", "/api/developer/v1/usage"),
		];
		const sentWithKey = answers.length - 1;
		for (let request = sentWithKey; request < 60; request++) {
			await from("GET", "/api/developer/v1/usage");
		}
		answers.push(await from("GET", "/api/developer/v1/usage"));

		expect(answers.map((response) => response.status)).toEqual([
			200, 400, 400, 401, 404, 405, 429,
		]);
		for (const response of answers) {
			expect(corsHeaders(response)).toEqual([]);
			expect(response.headers.get("Vary")).toBeNull();
		}
	});

	it.each([
		"/api/developer/v1/videos",
		"/api/developer/v1/videos/video-1",
		"/api/developer/v1/videos/video-1/status",
		"/api/developer/v1/uploads",
		"/api/developer/v1/transcripts",
		"/api/developer/v1/transactions",
		"/api/developer/v1/usage",
		"/api/developer/v1/nope",
	])("refuses a preflight for %s", async (path) => {
		const preflight = await call(rest, "OPTIONS", path, {
			headers: PREFLIGHT_HEADERS,
		});

		expect(preflight.ok).toBe(false);
		expect(corsHeaders(preflight)).toEqual([]);
		expect(mocks.billing).not.toHaveBeenCalled();
	});

	it("still answers a preflight for the upload routes", async () => {
		const preflight = await call(
			sdk,
			"OPTIONS",
			"/api/developer/sdk/v1/upload/multipart/presign-part",
			{
				headers: {
					...PREFLIGHT_HEADERS,
					"Access-Control-Request-Method": "POST",
				},
			},
		);

		expect(preflight.status).toBe(204);
		expect(Object.fromEntries(preflight.headers)).toEqual({
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET,POST,OPTIONS",
			"access-control-allow-headers": "Content-Type,Authorization",
			"access-control-expose-headers":
				"Retry-After,X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset",
			vary: "Access-Control-Request-Headers",
		});
	});

	it("still lets a page read an upload route's answer", async () => {
		const response = await call(
			sdk,
			"POST",
			"/api/developer/sdk/v1/upload/multipart/initiate",
			{
				key: freshKey("cut"),
				headers: { ...ORIGIN_HEADERS, "Content-Type": "application/json" },
				body: "{}",
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});
});

describe("wrong method and unknown path", () => {
	it.each([
		[rest, "PATCH", "/api/developer/v1/videos/video-1", "csk", "GET, DELETE"],
		[rest, "PUT", "/api/developer/v1/videos/video-1", "csk", "GET, DELETE"],
		[rest, "POST", "/api/developer/v1/videos", "csk", "GET"],
		[rest, "DELETE", "/api/developer/v1/videos/video-1/status", "csk", "GET"],
		[rest, "POST", "/api/developer/v1/usage", "csk", "GET"],
		[rest, "DELETE", "/api/developer/v1/transcripts", "csk", "POST, GET"],
		[rest, "GET", "/api/developer/v1/uploads", "csk", "POST"],
		[
			sdk,
			"DELETE",
			"/api/developer/sdk/v1/upload/multipart/abort",
			"cut",
			"POST",
		],
	] as const)(
		"answers 405 for %s %s %s",
		async (routes, method, path, prefix, allow) => {
			const response = await call(routes, method, path, {
				key: freshKey(prefix),
			});

			expect(response.status).toBe(405);
			expect(response.headers.get("Allow")).toBe(allow);
			expect(await response.json()).toMatchObject({
				error: `${method} is not allowed for ${path}`,
				code: "method_not_allowed",
				hint: `Use ${allow.split(", ").join(" or ")} for this path.`,
			});
		},
	);

	it.each([
		[rest, "GET", "/api/developer/v1/nope", "csk"],
		[rest, "POST", "/api/developer/v1/videos/a/b/c", "csk"],
		[rest, "GET", "/api/developer/v1/usage/extra", "csk"],
		[sdk, "POST", "/api/developer/sdk/v1/upload/multipart", "cut"],
		[sdk, "POST", "/api/developer/sdk/v1/videos/create", "cut"],
	] as const)(
		"keeps 404 for %s %s %s, a path no method serves",
		async (routes, method, path, prefix) => {
			const response = await call(routes, method, path, {
				key: freshKey(prefix),
			});

			expect(response.status).toBe(404);
			expect(response.headers.get("Allow")).toBeNull();
			expect(await response.json()).toMatchObject({ code: "not_found" });
		},
	);

	it("still asks for a key before saying which methods a path takes", async () => {
		const response = await call(
			rest,
			"PATCH",
			"/api/developer/v1/videos/video-1",
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "invalid_secret_key" });
	});
});

describe("errors thrown inside a handler", () => {
	const failing = async (error: Error) => {
		const { Hono } = await import("hono");
		const { developerApiError } = await import("@/app/api/utils");
		const app = new Hono()
			.get("/", () => {
				throw error;
			})
			.onError(developerApiError);
		return app.request("/");
	};

	it("answers a thrown HTTP exception as JSON with its status", async () => {
		const { HTTPException } = await import("hono/http-exception");

		const response = await failing(
			new HTTPException(400, { message: "Malformed JSON in request body" }),
		);

		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toMatchObject({
			error: "Malformed JSON in request body",
			code: "invalid_request",
			hint: expect.stringContaining("/openapi.json"),
		});
	});

	it("hides the detail of anything else behind a 500", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await failing(new Error("connection string leaked"));

		expect(response.status).toBe(500);
		const body = await response.json();
		expect(body).toMatchObject({ code: "internal_error" });
		expect(JSON.stringify(body)).not.toContain("connection string");
	});
});

describe("creating an upload with the wrong content type", () => {
	const create = (headers: Record<string, string>, body?: string) =>
		call(rest, "POST", "/api/developer/v1/uploads", {
			key: freshKey("csk"),
			headers,
			body,
		});
	const payload = JSON.stringify({ name: "Demo", userId: "user_42" });

	it.each([
		["no content type", {}, payload],
		["text/plain", { "Content-Type": "text/plain" }, payload],
		[
			"a form body",
			{ "Content-Type": "application/x-www-form-urlencoded" },
			"name=x",
		],
	] as const)(
		"refuses %s instead of creating an untitled video",
		async (_label, headers, body) => {
			const response = await create(headers, body);

			expect(response.status).toBe(415);
			expect(await response.json()).toMatchObject({
				error: "Request body must be sent as application/json",
				code: "unsupported_media_type",
			});
			expect(mocks.createVideo).not.toHaveBeenCalled();
		},
	);

	it("passes the fields through when the body is JSON", async () => {
		const response = await create(
			{ "Content-Type": "application/json" },
			payload,
		);

		expect(response.status).toBe(200);
		expect(mocks.createVideo).toHaveBeenCalledExactlyOnceWith({
			appId: "app-1",
			name: "Demo",
			userId: "user_42",
		});
	});

	it("still creates a video with defaults when no body is sent at all", async () => {
		const response = await create({});

		expect(response.status).toBe(200);
		expect(mocks.createVideo).toHaveBeenCalledExactlyOnceWith({
			appId: "app-1",
		});
	});

	it("answers malformed JSON as JSON", async () => {
		const response = await create(
			{ "Content-Type": "application/json" },
			'{"name": ',
		);

		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toMatchObject({ code: "invalid_json" });
		expect(mocks.createVideo).not.toHaveBeenCalled();
	});

	it("puts a string in error for a field that fails validation", async () => {
		const response = await create(
			{ "Content-Type": "application/json" },
			JSON.stringify({ maxResolutionTier: "8k" }),
		);

		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.code).toBe("invalid_request");
		expect(body.error).toMatch(/^Invalid request: maxResolutionTier: /);
		expect(body.issues[0].path).toEqual(["maxResolutionTier"]);
		expect(mocks.createVideo).not.toHaveBeenCalled();
	});
});

describe("usage", () => {
	const usage = async () => {
		const response = await getUsage(freshKey("csk"));
		expect(response.status).toBe(200);
		return (await response.json()).data;
	};

	it("counts only stored videos and reports those without a file as uploading", async () => {
		const data = await usage();

		expect(data).toMatchObject({
			balanceMicroCredits: 4_532_000,
			balanceDollars: "45.32",
			totalVideos: 3,
			uploadingVideos: 1,
			totalDurationMinutes: 12.5,
			storage: {
				minutesByTier: { "1080p": 12.5, "1440p": 0, "2160p": 0 },
			},
		});

		const stats = mocks.selected.find((fields) => "uploadedVideos" in fields);
		const dialect = new MySqlDialect();
		const sqlOf = (name: string) =>
			dialect.sqlToQuery(
				stats?.[name] as Parameters<typeof dialect.sqlToQuery>[0],
			).sql;
		expect(sqlOf("uploadedVideos")).toBe(
			"count(`developer_videos`.`duration`)",
		);
		expect(sqlOf("createdVideos")).toBe("count(*)");
	});

	it("reports zero for an app with no videos", async () => {
		mocks.videoStats = [];
		mocks.storedVideos = [];
		mocks.accounts = [];

		expect(await usage()).toMatchObject({
			balanceMicroCredits: 0,
			totalVideos: 0,
			uploadingVideos: 0,
		});
	});

	it("publishes the rates the pricing module charges", async () => {
		const { rates } = await usage();

		expect(rates).toEqual({
			microCreditsPerDollar: MICRO_CREDITS_PER_DOLLAR,
			storageDollarsPer1000MinutesPerMonth:
				INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
			speechDollarsPerHour: SPEECH_DOLLARS_PER_HOUR,
			uploadAdmissionDays: UPLOAD_ADMISSION_DAYS,
		});
		expect(Object.keys(rates.storageDollarsPer1000MinutesPerMonth)).toEqual([
			...INFRA_RESOLUTION_TIERS,
		]);
		expect(rates.uploadAdmissionDays).toBe(7);
		expect(uploadAdmissionMicroCredits(30_000)).toBe(
			(30_000 * rates.uploadAdmissionDays) / 30,
		);
	});

	it("returns the fields the OpenAPI description requires", async () => {
		mocks.billing.mockImplementation(() =>
			billingOf({ standing: {}, upload: {}, storage: {} }),
		);
		const schema = developerOpenApiSpec(ORIGIN).components.schemas.Usage;

		const data = await usage();

		expect(Object.keys(data).sort()).toEqual([...schema.required].sort());
		expect(Object.keys(data.rates).sort()).toEqual(
			[...schema.properties.rates.required].sort(),
		);
	});
});
