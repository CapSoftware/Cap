import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	keyRows: [] as {
		appId: string;
		keyId?: string;
		ownerId?: string;
		environment?: string;
	}[],
	hashKey: vi.fn(),
	accounts: [] as { balanceMicroCredits: number }[],
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
	const rowsFor = (table: unknown) => {
		if (table === schema.developerApiKeys) return mocks.keyRows;
		if (table === schema.developerCreditAccounts) return mocks.accounts;
		if (table === schema.developerVideos) return mocks.storedVideos;
		return [];
	};
	const select = (fields?: Record<string, unknown>) => ({
		from: (table: unknown) => {
			if (fields) mocks.selected.push(fields);
			const where = () =>
				Object.assign(Promise.resolve(rowsFor(table)), {
					limit: async () => rowsFor(table),
					groupBy: async () => rowsFor(table),
					orderBy: () => ({ limit: async () => rowsFor(table) }),
				});
			const query = {
				innerJoin: () => query,
				leftJoin: () => query,
				where,
			};
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

import { Hono } from "hono";
import * as sdk from "@/app/api/developer/sdk/v1/[...route]/route";
import * as rest from "@/app/api/developer/v1/[...route]/route";
import {
	developerOwnerRequestLimited,
	withDeveloperSecretAuth,
} from "@/app/api/utils";
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
	DEVELOPER_AUTH_FAILURES_PER_MINUTE as FAILURES,
} from "@/lib/developer-rate-limits";
import { createDeveloperUploadToken } from "@/lib/developer-upload-token";
import {
	INFRA_RESOLUTION_TIERS,
	INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
} from "@/lib/infra-pricing";
import { getAppStorage } from "@/lib/infra-storage";

const KEY_LIMIT = DEVELOPER_KEY_REQUESTS_PER_MINUTE;
const OWNER_LIMIT = DEVELOPER_OWNER_REQUESTS_PER_MINUTE;
const keyLeft = (sent: number) => String(KEY_LIMIT - sent);

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
				keyId: "key-contract",
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
	mocks.storedVideos = [
		{
			appId: "app-1",
			width: 1920,
			height: 1080,
			status: "ready",
			maxResolutionTier: "1080p",
			seconds: 750,
			count: 3,
			rows: 3,
			dailySeconds: 750,
			dailyCount: 3,
		},
		{
			appId: "app-1",
			width: 1920,
			height: 1080,
			status: "errored",
			maxResolutionTier: "1080p",
			seconds: 345.21,
			count: 1,
			rows: 1,
			dailySeconds: 345.21,
			dailyCount: 1,
		},
		{
			appId: "app-1",
			width: null,
			height: null,
			status: "uploading",
			maxResolutionTier: "1080p",
			seconds: 0,
			count: 0,
			rows: 1,
			dailySeconds: 0,
			dailyCount: 0,
		},
	];
	mocks.selected = [];
	mocks.billing.mockImplementation(async (appId: string) => {
		const storage = await getAppStorage(appId);
		return { standing: { state: "active" }, storage, stored: storage.stored };
	});
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
			limit: String(KEY_LIMIT),
			remaining: keyLeft(1),
			reset: "60",
			retryAfter: null,
		});

		vi.advanceTimersByTime(20_500);
		const second = await getUsage(key);
		expect(rateLimit(second)).toMatchObject({
			remaining: keyLeft(2),
			reset: "40",
		});

		for (let request = 3; request <= KEY_LIMIT; request++) await getUsage(key);
		vi.advanceTimersByTime(4_500);
		const limited = await getUsage(key);
		expect(limited.status).toBe(429);
		expect(rateLimit(limited)).toEqual({
			limit: String(KEY_LIMIT),
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
			remaining: keyLeft(1),
			reset: "60",
		});
	});

	it("keeps Retry-After equal to the time left as the window runs down", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
		const key = freshKey("csk");
		for (let request = 1; request <= KEY_LIMIT; request++) await getUsage(key);

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

		expect(rateLimit(upper).remaining).toBe(keyLeft(1));
		expect(rateLimit(lower).remaining).toBe(keyLeft(2));
		expect(rateLimit(spaced).remaining).toBe(keyLeft(3));
		expect(rateLimit(other).remaining).toBe(keyLeft(1));
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
			[404, keyLeft(1)],
			[405, keyLeft(2)],
			[500, keyLeft(3)],
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
			"X-Request-Id",
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
			limit: String(KEY_LIMIT),
			remaining: "0",
			reset: "60",
			retryAfter: "60",
		});
		expect(await limited.json()).toMatchObject({
			error: "Rate limit exceeded",
			code: "rate_limited",
			hint: `Wait for the Retry-After seconds, then retry. Each key allows ${KEY_LIMIT} requests per minute.`,
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
		for (let request = 1; request <= KEY_LIMIT; request++) await getUsage(key);

		const allowed = await getUsage(key);

		expect(allowed.status).toBe(200);
		expect(rateLimit(allowed)).toMatchObject({
			limit: String(KEY_LIMIT),
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
			limit: String(KEY_LIMIT),
			remaining: keyLeft(1),
			reset: "60",
			retryAfter: null,
		});
		for (let request = 2; request <= KEY_LIMIT; request++) {
			expect((await getUsage(key)).status).toBe(200);
		}
		vi.advanceTimersByTime(25_000);
		const limited = await getUsage(key);

		expect(limited.status).toBe(429);
		expect(rateLimit(limited)).toEqual({
			limit: String(KEY_LIMIT),
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

	it("allows the account budget across every key of an account, then answers 429", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
		ownedBy("owner-shared");
		// Every key stays under its own limit, so only the account budget can
		// refuse the request after them.
		const perKey = Math.min(KEY_LIMIT - 1, OWNER_LIMIT);
		const keys = Array.from({ length: Math.ceil(OWNER_LIMIT / perKey) }, () =>
			freshKey("csk"),
		);
		expect(keys.length).toBeGreaterThan(1);

		for (const [index, key] of keys.entries()) {
			const sends = Math.min(perKey, OWNER_LIMIT - index * perKey);
			for (let request = 1; request <= sends; request++) {
				expect((await getUsage(key)).status).toBe(200);
			}
		}
		vi.advanceTimersByTime(20_000);
		const limited = await getUsage(freshKey("csk"));

		expect(limited.status).toBe(429);
		expect(rateLimit(limited)).toEqual({
			limit: String(KEY_LIMIT),
			remaining: "0",
			reset: "40",
			retryAfter: "40",
		});
		expect(await limited.json()).toMatchObject({
			code: "rate_limited",
			hint: `Wait for the Retry-After seconds, then retry. Each account, across all of its keys, allows ${OWNER_LIMIT} requests per minute.`,
		});
		expect(mocks.billing).toHaveBeenCalledTimes(OWNER_LIMIT);

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
			"keyId",
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
			limit: String(KEY_LIMIT),
			remaining: "0",
			retryAfter: "60",
		});
		expect(mocks.billing).not.toHaveBeenCalled();
	});
});

describe("the console's webhook actions share the account budget", () => {
	it("counts console requests and REST requests in one account budget", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
		mocks.keyRows = [{ appId: "app-1", ownerId: "owner-console" }];
		const fromConsole = (owner = "owner-console") =>
			developerOwnerRequestLimited(owner, new Headers());

		for (let request = 1; request < OWNER_LIMIT; request++) {
			expect(await fromConsole()).toBe(false);
		}
		expect((await getUsage(freshKey("csk"))).status).toBe(200);
		expect(await fromConsole()).toBe(true);
		expect((await getUsage(freshKey("csk"))).status).toBe(429);
		expect(await fromConsole("owner-other")).toBe(false);

		vi.advanceTimersByTime(60_001);
		expect(await fromConsole()).toBe(false);
	});

	it("asks the shared rule about the account by its id", async () => {
		vi.stubEnv("NODE_ENV", "production");

		await developerOwnerRequestLimited("owner-console-asked", new Headers());

		expect(
			mocks.firewall.mock.calls.map(([ruleId, options]) => [
				ruleId,
				options.rateLimitKey,
			]),
		).toEqual([["rl_developer_api_owner", "owner-console-asked"]]);
	});

	it("is refused when the shared rule for the account says so", async () => {
		vi.stubEnv("NODE_ENV", "production");
		mocks.firewall.mockResolvedValue({ rateLimited: true });

		expect(
			await developerOwnerRequestLimited("owner-console-shared", new Headers()),
		).toBe(true);
	});
});

describe("secret key check behind other middleware", () => {
	const guarded = (preset: Record<string, string>) =>
		new Hono<{ Variables: Record<string, string> }>()
			.use(async (c, next) => {
				for (const [name, value] of Object.entries(preset)) c.set(name, value);
				await next();
			})
			.use(withDeveloperSecretAuth)
			.get("/", (c) =>
				c.json({
					appId: c.get("developerAppId"),
					keyId: c.get("developerKeyId") ?? null,
				}),
			);
	const send = (
		preset: Record<string, string>,
		headers: Record<string, string> = {},
	) => guarded(preset).request("https://cap.so/", { headers });

	it("still asks for a secret key when an app was set by something other than a secret key", async () => {
		const response = await send({ developerAppId: "app-from-token" });

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			code: "invalid_secret_key",
		});
		expect(mocks.hashKey).not.toHaveBeenCalled();
	});

	it("takes the app and key from the secret key, not from what was set before", async () => {
		mocks.keyRows = [{ appId: "app-1", keyId: "key-1", ownerId: "owner-1" }];

		const response = await send(
			{ developerAppId: "app-from-token" },
			{ Authorization: `Bearer ${freshKey("csk")}` },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ appId: "app-1", keyId: "key-1" });
		expect(mocks.hashKey).toHaveBeenCalledTimes(1);
	});

	it("does not look the key up again once the rate limiter accepted it", async () => {
		const response = await send({
			developerAppId: "app-1",
			developerKeyId: "key-1",
			developerKeyType: "secret",
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ appId: "app-1", keyId: "key-1" });
		expect(mocks.hashKey).not.toHaveBeenCalled();
	});
});

describe("credentials that are not accepted", () => {
	const from = (address: string) => ({ "x-forwarded-for": address });

	it.each([
		["no credential", undefined, 401, "invalid_secret_key"],
		[
			"a credential with no prefix",
			"Bearer not-a-key",
			401,
			"invalid_secret_key",
		],
		["a public key", "Bearer cpk_public_1", 403, "public_key_not_allowed"],
		[
			"an oversized key",
			`Bearer csk_${"a".repeat(200)}`,
			401,
			"invalid_secret_key",
		],
		[
			"a key with characters no key has",
			"Bearer csk_abc!def",
			401,
			"invalid_secret_key",
		],
	] as const)(
		"refuses %s without hashing, looking up or counting anything",
		async (_label, authorization, status, code) => {
			vi.stubEnv("NODE_ENV", "production");

			const response = await call(rest, "GET", "/api/developer/v1/usage", {
				headers: authorization ? { Authorization: authorization } : {},
			});

			expect(response.status).toBe(status);
			expect(await response.json()).toMatchObject({ code });
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

	it("answers an unknown key 401 on any path, and stops looking keys up for an address after many different ones in a minute", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
		mocks.keyRows = [];
		const address = from("203.0.113.9");

		for (let attempt = 1; attempt <= FAILURES; attempt++) {
			const refused = await call(rest, "GET", "/api/developer/v1/nope", {
				key: freshKey("csk"),
				headers: address,
			});
			expect(refused.status).toBe(401);
		}
		expect(mocks.hashKey).toHaveBeenCalledTimes(FAILURES);

		const limited = await getUsage(freshKey("csk"), address);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("Retry-After")).toBe("60");
		expect(await limited.json()).toMatchObject({
			code: "rate_limited",
			error: "Too many requests with a key or token that was not accepted",
		});
		expect(mocks.hashKey).toHaveBeenCalledTimes(FAILURES + 1);

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
		for (let attempt = 1; attempt <= FAILURES + 1; attempt++) {
			await getUsage(freshKey("csk"), address);
		}
		expect((await getUsage(freshKey("csk"), address)).status).toBe(429);

		mocks.keyRows = accepted;
		expect((await getUsage(customer, address)).status).toBe(200);
	});

	it("counts that minute from the key's last accepted request, not from when its count began", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T11:30:00Z"));
		const address = from("203.0.113.78");
		const accepted = mocks.keyRows;
		const customer = freshKey("csk");
		expect((await getUsage(customer, address)).status).toBe(200);
		vi.advanceTimersByTime(59_000);
		expect((await getUsage(customer, address)).status).toBe(200);

		mocks.keyRows = [];
		for (let attempt = 1; attempt <= FAILURES + 1; attempt++) {
			await getUsage(freshKey("csk"), address);
		}
		expect((await getUsage(freshKey("csk"), address)).status).toBe(429);

		mocks.keyRows = accepted;
		vi.advanceTimersByTime(2_000);
		expect((await getUsage(customer, address)).status).toBe(200);

		vi.advanceTimersByTime(61_000);
		mocks.keyRows = [];
		for (let attempt = 1; attempt <= FAILURES + 1; attempt++) {
			await getUsage(freshKey("csk"), address);
		}
		mocks.keyRows = accepted;
		expect((await getUsage(customer, address)).status).toBe(429);
	});

	it("keeps a valid key working from an address that sent refused keys, on an instance that never saw it before", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T13:00:00Z"));
		const address = from("203.0.113.90");
		const accepted = mocks.keyRows;
		mocks.keyRows = [];
		for (let attempt = 1; attempt <= 30; attempt++) {
			expect((await getUsage(freshKey("csk"), address)).status).toBe(401);
		}

		mocks.keyRows = accepted;
		expect((await getUsage(freshKey("csk"), address)).status).toBe(200);
	});

	it("refuses a key it already refused at once, without a lookup or a count, so a stale worker cannot block its address", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T13:10:00Z"));
		const address = { "x-real-ip": "203.0.113.91" };
		const accepted = mocks.keyRows;
		mocks.keyRows = [];
		const rotated = freshKey("csk");

		for (let attempt = 1; attempt <= FAILURES * 2; attempt++) {
			expect((await getUsage(rotated, address)).status).toBe(401);
		}
		expect(mocks.hashKey).toHaveBeenCalledTimes(1);
		expect(
			mocks.firewall.mock.calls.filter(
				([ruleId]) => ruleId === "rl_developer_auth_failure",
			),
		).toHaveLength(1);

		mocks.keyRows = accepted;
		expect((await getUsage(freshKey("csk"), address)).status).toBe(200);

		mocks.keyRows = [];
		vi.advanceTimersByTime(60_001);
		mocks.hashKey.mockClear();
		expect((await getUsage(rotated, address)).status).toBe(401);
		expect(mocks.hashKey).toHaveBeenCalledTimes(1);
	});

	it("counts a burst of parallel retries with one refused key once, so a valid key from that address still passes", async () => {
		vi.stubEnv("NODE_ENV", "production");
		const address = { "x-real-ip": "203.0.113.93" };
		const accepted = mocks.keyRows;
		mocks.keyRows = [];
		const rotated = freshKey("csk");
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		mocks.hashKey.mockImplementation(async (key: string) => {
			await gate;
			return `hash:${key}`;
		});

		const burst = Array.from({ length: 50 }, () => getUsage(rotated, address));
		await new Promise((resolve) => setTimeout(resolve, 50));
		release();
		const statuses = (await Promise.all(burst)).map(
			(response) => response.status,
		);

		expect(statuses).toEqual(Array(50).fill(401));
		expect(mocks.hashKey).toHaveBeenCalledTimes(1);
		expect(
			mocks.firewall.mock.calls.filter(
				([ruleId]) => ruleId === "rl_developer_auth_failure",
			),
		).toHaveLength(1);

		mocks.hashKey.mockImplementation(async (key: string) => `hash:${key}`);
		mocks.keyRows = accepted;
		expect((await getUsage(freshKey("csk"), address)).status).toBe(200);
	});

	it("bounds the lookups an address sending different refused keys can cause to the per-address ceiling", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T13:20:00Z"));
		mocks.keyRows = [];
		const address = from("203.0.113.92");

		for (let attempt = 1; attempt <= FAILURES * 3; attempt++) {
			await getUsage(freshKey("csk"), address);
		}

		expect(mocks.hashKey).toHaveBeenCalledTimes(FAILURES + 1);
	});

	it("counts by the address the platform reports, not one the caller writes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
		vi.stubEnv("VERCEL", "1");
		mocks.keyRows = [];
		const statuses: number[] = [];

		for (let attempt = 1; attempt <= FAILURES + 2; attempt++) {
			const response = await getUsage(freshKey("csk"), {
				"x-real-ip": "203.0.113.200",
				"x-forwarded-for": `10.0.0.${attempt}, 203.0.113.200`,
				"x-client-ip": `10.9.9.${attempt}`,
			});
			statuses.push(response.status);
		}

		expect(statuses.slice(0, FAILURES)).toEqual(Array(FAILURES).fill(401));
		expect(statuses.slice(FAILURES)).toEqual([429, 429]);
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
		for (let attempt = 2; attempt <= FAILURES; attempt++) await forged();

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

	it("keeps the secret key at 300 a minute", async () => {
		expect(rateLimit(await getUsage(freshKey("csk"))).limit).toBe("300");
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
			`All the keys of one account together allow ${DEVELOPER_OWNER_REQUESTS_PER_MINUTE.toLocaleString("en-US")} requests per minute`,
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
		for (let request = sentWithKey; request < KEY_LIMIT; request++) {
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
				"Retry-After,X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset,X-Request-Id",
			"access-control-max-age": "7200",
			"cache-control": "private, no-store",
			vary: "Access-Control-Request-Headers",
		});
	});

	it.each([
		"/api/developer/sdk/v1/upload/multipart/initiate",
		"/api/developer/sdk/v1/upload/multipart/presign-part",
		"/api/developer/sdk/v1/upload/multipart/complete",
		"/api/developer/sdk/v1/upload/multipart/abort",
	])(
		"lets a browser cache the preflight for %s for two hours",
		async (path) => {
			const preflight = await call(sdk, "OPTIONS", path, {
				headers: {
					...PREFLIGHT_HEADERS,
					"Access-Control-Request-Method": "POST",
				},
			});

			expect(preflight.status).toBe(204);
			expect(preflight.headers.get("Access-Control-Max-Age")).toBe("7200");
		},
	);

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

describe("the credential sent to the REST API", () => {
	it("says the key is missing when no Authorization header is sent", async () => {
		const response = await getUsage("");

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			code: "invalid_secret_key",
			error: "Missing secret key",
			hint: expect.stringContaining("No Authorization header was sent"),
		});
	});

	it("refuses a public key with its own code", async () => {
		const response = await getUsage(freshKey("cpk"));

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			code: "public_key_not_allowed",
			error: "Public keys cannot call the REST API",
			hint: expect.stringContaining("csk_"),
		});
		expect(mocks.billing).not.toHaveBeenCalled();
	});

	it("keeps the answers for any other credential and for a wrong secret key", async () => {
		const other = await getUsage("not_a_key");
		mocks.keyRows = [];
		const wrong = await getUsage(freshKey("csk"));

		expect(other.status).toBe(401);
		expect(await other.json()).toMatchObject({
			code: "invalid_secret_key",
			error: "Invalid secret key",
		});
		expect(wrong.status).toBe(401);
		expect(await wrong.json()).toMatchObject({
			code: "invalid_secret_key",
			error: "Invalid or revoked secret key",
		});
	});
});

describe("wrong method and unknown path", () => {
	it.each([
		[rest, "PATCH", "/api/developer/v1/videos/video-1", "csk", "GET, DELETE"],
		[rest, "PUT", "/api/developer/v1/videos/video-1", "csk", "GET, DELETE"],
		[rest, "PUT", "/api/developer/v1/videos", "csk", "POST, GET"],
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

	it("lists the 405 on every operation of a path that answers it, with the methods the path takes", async () => {
		const spec = developerOpenApiSpec("https://cap.so") as unknown as {
			paths: Record<
				string,
				Record<string, { responses?: Record<string, unknown> }>
			>;
		};
		const methods = ["PUT", "PATCH", "DELETE", "POST", "GET"] as const;
		const paths = Object.entries(spec.paths).filter(([path]) =>
			path.startsWith("/api/developer/"),
		);
		expect(paths.length).toBeGreaterThan(15);

		for (const [path, item] of paths) {
			const listed = Object.keys(item).map((method) => method.toUpperCase());
			for (const method of listed) {
				expect(
					item[method.toLowerCase()]?.responses?.["405"],
					`${method} ${path}`,
				).toEqual({ $ref: "#/components/responses/MethodNotAllowed" });
			}

			const sdkPath = path.startsWith("/api/developer/sdk/");
			const concrete = path.replace("{id}", "video-1");
			const unlisted = methods.find((method) => !listed.includes(method));
			if (!unlisted) throw new Error(`${path} takes every method`);
			const response = await call(sdkPath ? sdk : rest, unlisted, concrete, {
				key: freshKey(sdkPath ? "cut" : "csk"),
			});

			expect(response.status, `${unlisted} ${path}`).toBe(405);
			expect(
				response.headers.get("Allow")?.split(", "),
				`${unlisted} ${path}`,
			).toEqual(expect.arrayContaining(listed));
			expect(await response.json()).toMatchObject({
				code: "method_not_allowed",
			});
		}
	});

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

		const aggregate = mocks.selected.filter((fields) => "rows" in fields);
		expect(aggregate).toHaveLength(1);
		const dialect = new MySqlDialect();
		const sqlOf = (name: string) =>
			dialect.sqlToQuery(
				aggregate[0]?.[name] as Parameters<typeof dialect.sqlToQuery>[0],
			).sql;
		expect(sqlOf("count")).toBe("COUNT(`developer_videos`.`duration`)");
		expect(sqlOf("rows")).toBe("COUNT(*)");
	});

	it("reports zero for an app with no videos", async () => {
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
		const storage = await getAppStorage("app-1");
		mocks.billing.mockResolvedValue({
			standing: {},
			upload: {},
			storage,
			stored: storage.stored,
		});
		const schema = developerOpenApiSpec(ORIGIN).components.schemas.Usage;

		const data = await usage();

		expect(Object.keys(data).sort()).toEqual([...schema.required].sort());
		expect(Object.keys(data.rates).sort()).toEqual(
			[...schema.properties.rates.required].sort(),
		);
	});
});

describe("Idempotency-Key on create upload", () => {
	const create = (headers: Record<string, string>) =>
		call(rest, "POST", "/api/developer/v1/uploads", {
			key: freshKey("csk"),
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify({ name: "Demo" }),
		});

	it("passes a valid key to the store", async () => {
		const response = await create({ "Idempotency-Key": "retry-upload-0001" });

		expect(response.status).toBe(200);
		expect(mocks.createVideo).toHaveBeenCalledExactlyOnceWith({
			appId: "app-1",
			name: "Demo",
			idempotencyKey: "retry-upload-0001",
		});
	});

	it.each([
		["too short", "short"],
		["a colon", "retry:upload:0001"],
		["a space", "retry upload 0001"],
		["too long", "k".repeat(129)],
	])("refuses a key with %s before creating anything", async (_label, key) => {
		const response = await create({ "Idempotency-Key": key });

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: "invalid_idempotency_key",
			error: "Idempotency-Key is not valid",
		});
		expect(mocks.createVideo).not.toHaveBeenCalled();
	});
});

describe("response headers on the developer APIs", () => {
	const PRIVATE = "private, no-store";

	it("marks every secret-key API answer private, errors and limits included", async () => {
		const key = freshKey("csk");
		const answers = [
			await call(rest, "GET", "/api/developer/v1/usage", { key }),
			await call(rest, "GET", "/api/developer/v1/usage"),
			await call(rest, "GET", "/api/developer/v1/nope", { key }),
			await call(rest, "POST", "/api/developer/v1/usage", { key }),
		];
		for (
			let request = 3;
			request < DEVELOPER_KEY_REQUESTS_PER_MINUTE;
			request++
		) {
			await call(rest, "GET", "/api/developer/v1/usage", { key });
		}
		answers.push(await call(rest, "GET", "/api/developer/v1/usage", { key }));

		expect(answers.map((response) => response.status)).toEqual([
			200, 401, 404, 405, 429,
		]);
		for (const response of answers) {
			expect(response.headers.get("Cache-Control")).toBe(PRIVATE);
		}
	});

	it("marks the upload token API answers private too", async () => {
		const answers = [
			await call(
				sdk,
				"POST",
				"/api/developer/sdk/v1/upload/multipart/initiate",
				{
					key: freshKey("cut"),
					headers: { "Content-Type": "application/json" },
					body: "{}",
				},
			),
			await call(
				sdk,
				"POST",
				"/api/developer/sdk/v1/upload/multipart/initiate",
				{
					headers: { "Content-Type": "application/json" },
					body: "{}",
				},
			),
		];

		expect(answers.map((response) => response.status)).toEqual([200, 401]);
		for (const response of answers) {
			expect(response.headers.get("Cache-Control")).toBe(PRIVATE);
		}
	});

	it("echoes the platform request id and lets a page read it", async () => {
		const requestId = "fra1::iad1::abcde-1763031000000-0123456789ab";
		const rested = await call(rest, "GET", "/api/developer/v1/usage", {
			key: freshKey("csk"),
			headers: { "x-vercel-id": requestId },
		});
		const sdked = await call(
			sdk,
			"POST",
			"/api/developer/sdk/v1/upload/multipart/initiate",
			{
				key: freshKey("cut"),
				headers: {
					Origin: "https://app.example",
					"Content-Type": "application/json",
					"x-vercel-id": requestId,
				},
				body: "{}",
			},
		);

		expect(rested.headers.get("X-Request-Id")).toBe(requestId);
		expect(sdked.headers.get("X-Request-Id")).toBe(requestId);
		expect(
			sdked.headers
				.get("Access-Control-Expose-Headers")
				?.split(",")
				.map((name) => name.trim()),
		).toContain("X-Request-Id");
		const withoutId = await call(rest, "GET", "/api/developer/v1/usage", {
			key: freshKey("csk"),
		});
		expect(withoutId.headers.get("X-Request-Id")).toBeNull();
	});
});

describe("OpenAPI description", () => {
	it("names the product Cap Infra API", () => {
		const { info } = developerOpenApiSpec(ORIGIN);
		expect(info.title).toBe("Cap Infra API");
		expect(info.description).toMatch(/^The Cap Infra API does two things/);
		expect(JSON.stringify(info)).not.toContain("Developer API");
	});
});

describe("video captions in OpenAPI", () => {
	it("documents captions on the video as language and url, outside what webhooks must carry", () => {
		const spec = developerOpenApiSpec(ORIGIN) as unknown as {
			components: {
				schemas: {
					DeveloperVideo: {
						required: string[];
						properties: {
							captions: {
								type: string;
								items: { required: string[]; properties: object };
							};
						};
					};
				};
			};
		};
		const video = spec.components.schemas.DeveloperVideo;
		expect(video.properties.captions.type).toBe("array");
		expect(video.properties.captions.items.required).toEqual([
			"language",
			"url",
		]);
		expect(Object.keys(video.properties.captions.items.properties)).toEqual([
			"language",
			"url",
		]);
		expect(video.required).not.toContain("captions");
	});
});
