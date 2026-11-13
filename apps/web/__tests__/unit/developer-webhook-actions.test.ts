import { beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
	fake: null as null | {
		db: unknown;
		rows: (table: object) => Record<string, unknown>[];
		seed: (table: object, row: Record<string, unknown>) => unknown;
		reset: () => void;
	},
	user: null as null | { id: string; email: string },
	limited: false,
	resolved: ["93.184.216.34"] as string[],
	request: null as
		| null
		| ((url: string, init: RequestInit) => Promise<Response>),
}));

vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	const { createWebhookFakeDatabase, webhookEndpointDefaults } = await import(
		"./developer-webhook-fake-db"
	);
	const fake = createWebhookFakeDatabase(
		new Map([[schema.developerWebhookEndpoints, webhookEndpointDefaults]]),
	);
	context.fake = fake;
	return { db: () => fake.db };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => context.user,
}));
vi.mock("@/lib/infra-access", () => ({ canUseInfra: () => true }));
vi.mock("@cap/env", () => ({
	NODE_ENV: "production",
	buildEnv: {
		NEXT_PUBLIC_IS_CAP: "true",
		NEXT_PUBLIC_WEB_URL: "https://cap.so",
	},
	serverEnv: () => ({ DATABASE_ENCRYPTION_KEY: "ab".repeat(32) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/developer-app-limits", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/developer-app-limits")>()),
	developerConsoleRequestLimited: async () => context.limited,
}));
vi.mock("@/app/api/utils", async () => {
	const { createMiddleware } = await import("hono/factory");
	return {
		withDeveloperSecretAuth: createMiddleware(async (c, next) => {
			c.set("developerAppId", "app-a");
			await next();
		}),
	};
});
vi.mock("@/lib/s3-endpoint-policy", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/s3-endpoint-policy")>();
	return {
		...actual,
		isBlockedS3Endpoint: (url: string) =>
			actual.isBlockedS3Endpoint(url, async () => context.resolved),
	};
});
vi.mock("@/lib/storage-fetch", () => ({
	requestPublicOnly: (url: string, init: RequestInit) => {
		if (!context.request) throw new Error("no request expected");
		return context.request(url, init);
	},
}));

const { developerApps, developerWebhookEndpoints } = await import(
	"@cap/database/schema"
);
const { decrypt } = await import("@cap/database/crypto");
const actions = await import("@/actions/developers/webhooks");
const { verifyWebhookSignature } = await import(
	"@/lib/developer-webhook-signature"
);
const { app: restApp } = await import(
	"@/app/api/developer/v1/[...route]/webhooks"
);

const OWNER_A = { id: "user-a", email: "a@example.com" };
const OWNER_B = { id: "user-b", email: "b@example.com" };
const URL_A = "https://hooks.example.com/cap";

const endpoints = () => context.fake?.rows(developerWebhookEndpoints) ?? [];

const created = async (appId = "app-a", url = URL_A) => {
	const result = await actions.createInfraWebhook(appId, {
		url,
		events: ["video.ready", "video.errored"],
	});
	if (!result.success) throw new Error(result.message);
	return result;
};

const restCreate = async (body: Record<string, unknown>) => {
	const response = await restApp.request("/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return {
		status: response.status,
		body: (await response.json()) as {
			code: string;
			message: string;
			hint: string;
		},
	};
};

beforeEach(() => {
	context.fake?.reset();
	context.fake?.seed(developerApps, {
		id: "app-a",
		ownerId: OWNER_A.id,
		deletedAt: null,
	});
	context.fake?.seed(developerApps, {
		id: "app-b",
		ownerId: OWNER_B.id,
		deletedAt: null,
	});
	context.fake?.seed(developerApps, {
		id: "app-gone",
		ownerId: OWNER_A.id,
		deletedAt: new Date("2026-11-01T00:00:00Z"),
	});
	context.user = OWNER_A;
	context.limited = false;
	context.resolved = ["93.184.216.34"];
	context.request = null;
});

describe("console webhook actions: scoping", () => {
	it("answers 404 for another account's app and writes nothing", async () => {
		context.user = OWNER_B;
		const result = await actions.createInfraWebhook("app-a", {
			url: URL_A,
			events: ["video.ready"],
		});
		expect(result).toMatchObject({
			success: false,
			status: 404,
			code: "app_not_found",
		});
		expect(endpoints()).toHaveLength(0);
	});

	it("answers 404 for every action on another account's endpoint", async () => {
		const { endpoint } = await created();
		const before = structuredClone(endpoints());
		context.user = OWNER_B;

		for (const appId of ["app-a", "app-b"]) {
			const results = [
				await actions.setInfraWebhookEnabled(appId, endpoint.id, false),
				await actions.rotateInfraWebhookSecret(appId, endpoint.id),
				await actions.sendInfraWebhookTest(appId, endpoint.id),
				await actions.deleteInfraWebhook(appId, endpoint.id),
			];
			for (const result of results) {
				expect(result).toMatchObject({
					success: false,
					status: 404,
					code: appId === "app-a" ? "app_not_found" : "webhook_not_found",
				});
			}
		}
		expect(endpoints()).toEqual(before);
	});

	it("answers 404 for a deleted app", async () => {
		const result = await actions.createInfraWebhook("app-gone", {
			url: URL_A,
			events: ["video.ready"],
		});
		expect(result).toMatchObject({ status: 404, code: "app_not_found" });
		expect(endpoints()).toHaveLength(0);
	});

	it("refuses a signed-out visitor before reading anything", async () => {
		context.user = null;
		await expect(
			actions.createInfraWebhook("app-a", { url: URL_A, events: [] }),
		).rejects.toThrow("Unauthorized");
	});
});

describe("console webhook actions: the per-app cap", () => {
	it("allows five endpoints and refuses the sixth like the API", async () => {
		for (let index = 0; index < 5; index += 1) {
			await created("app-a", `https://hooks.example.com/cap/${index}`);
		}
		const sixth = await actions.createInfraWebhook("app-a", {
			url: "https://hooks.example.com/cap/6",
			events: ["video.ready"],
		});
		expect(sixth).toMatchObject({
			success: false,
			status: 409,
			code: "webhook_limit_reached",
			message: "An app can have 5 webhook endpoints",
		});
		expect(endpoints()).toHaveLength(5);

		const rest = await restCreate({ url: "https://hooks.example.com/cap/7" });
		expect(rest.status).toBe(409);
		expect(rest.body.message).toBe((sixth as { message: string }).message);
	});

	it("counts each app on its own and frees a slot on delete", async () => {
		const ids: string[] = [];
		for (let index = 0; index < 5; index += 1) {
			ids.push(
				(await created("app-a", `https://hooks.example.com/a/${index}`))
					.endpoint.id,
			);
		}
		context.user = OWNER_B;
		await created("app-b", "https://hooks.example.com/b");
		context.user = OWNER_A;

		const removed = await actions.deleteInfraWebhook("app-a", ids[0] ?? "");
		expect(removed).toEqual({ success: true });
		await created("app-a", "https://hooks.example.com/a/again");
	});
});

describe("console webhook actions: validation", () => {
	const cases: [string, { url: string; events: string[] }][] = [
		[
			"plain http",
			{ url: "http://hooks.example.com/cap", events: ["video.ready"] },
		],
		[
			"a port",
			{ url: "https://hooks.example.com:8443/cap", events: ["video.ready"] },
		],
		[
			"credentials",
			{ url: "https://u:p@hooks.example.com/cap", events: ["video.ready"] },
		],
		["not a URL", { url: "hooks example", events: ["video.ready"] }],
		["no events", { url: URL_A, events: [] }],
		["an unknown event", { url: URL_A, events: ["video.deleted"] }],
		[
			"a repeated event",
			{ url: URL_A, events: ["video.ready", "video.ready"] },
		],
	];

	it.each(cases)("refuses %s with the API's message", async (_name, input) => {
		const result = await actions.createInfraWebhook("app-a", input);
		expect(result).toMatchObject({ success: false, status: 400 });
		if (result.success) throw new Error("expected a refusal");

		const rest = await restCreate(input);
		expect(rest.status).toBe(400);
		if (rest.body.code === "invalid_webhook_url") {
			expect(result).toMatchObject({
				code: "invalid_webhook_url",
				message: rest.body.message,
				hint: rest.body.hint,
			});
		} else {
			expect(rest.body.message).toMatch(
				new RegExp(`: ${escape(result.message)}$`),
			);
		}
		expect(endpoints()).toHaveLength(0);
	});

	it("refuses a host that resolves to a private address", async () => {
		context.resolved = ["10.0.0.5"];
		const result = await actions.createInfraWebhook("app-a", {
			url: URL_A,
			events: ["video.ready"],
		});
		expect(result).toMatchObject({
			status: 400,
			code: "invalid_webhook_url",
			message: "The URL must point to a public address",
		});
	});

	it("refuses a non-boolean enabled value", async () => {
		const { endpoint } = await created();
		const result = await actions.setInfraWebhookEnabled(
			"app-a",
			endpoint.id,
			"yes" as unknown as boolean,
		);
		expect(result).toMatchObject({ status: 400, code: "invalid_request" });
		expect(endpoints()[0]?.enabled).toBe(true);
	});
});

describe("console webhook actions: secrets and the rest", () => {
	it("returns the signing secret once and never in an endpoint", async () => {
		const result = await created();
		expect(result.secret).toMatch(/^cws_[0-9a-z]{30}$/);
		expect(Object.keys(result.endpoint)).not.toContain("encryptedSecret");
		expect(JSON.stringify(result.endpoint)).not.toContain(result.secret);
		const [row] = endpoints();
		expect(String(row?.encryptedSecret)).not.toContain(result.secret);
		expect(await decrypt(String(row?.encryptedSecret))).toBe(result.secret);

		const rotated = await actions.rotateInfraWebhookSecret(
			"app-a",
			result.endpoint.id,
		);
		if (!rotated.success) throw new Error(rotated.message);
		expect(rotated.secret).not.toBe(result.secret);
		expect(JSON.stringify(rotated.endpoint)).not.toContain(rotated.secret);
		expect(await decrypt(String(endpoints()[0]?.encryptedSecret))).toBe(
			rotated.secret,
		);
	});

	it("turns an endpoint off and on, clearing a failure stop", async () => {
		const { endpoint } = await created();
		const row = endpoints()[0];
		if (!row) throw new Error("no row");
		Object.assign(row, {
			enabled: false,
			disabledReason: "delivery_failures",
			consecutiveFailures: 20,
		});

		const on = await actions.setInfraWebhookEnabled("app-a", endpoint.id, true);
		expect(on).toMatchObject({
			success: true,
			endpoint: { enabled: true, disabledReason: null, consecutiveFailures: 0 },
		});
		const off = await actions.setInfraWebhookEnabled(
			"app-a",
			endpoint.id,
			false,
		);
		expect(off).toMatchObject({ success: true, endpoint: { enabled: false } });
	});

	it("sends a signed test event and records it", async () => {
		const { endpoint, secret } = await created();
		const seen: { url: string; signature: string | null; body: string }[] = [];
		context.request = async (url, init) => {
			seen.push({
				url,
				signature: new Headers(init.headers).get("Cap-Signature"),
				body: String(init.body),
			});
			return new Response(null, { status: 204 });
		};

		const result = await actions.sendInfraWebhookTest("app-a", endpoint.id);
		expect(result).toMatchObject({
			success: true,
			test: { type: "webhook.test", delivered: true, responseStatus: 204 },
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.url).toBe(URL_A);
		expect(
			verifyWebhookSignature({
				secret,
				body: seen[0]?.body ?? "",
				header: seen[0]?.signature ?? null,
			}),
		).toBe(true);
		expect(seen[0]?.body).not.toContain(secret);
		expect(endpoints()[0]).toMatchObject({
			lastDeliveryStatus: "succeeded",
			lastResponseStatus: 204,
		});
	});

	it("deletes an endpoint so it is gone from every other action", async () => {
		const { endpoint } = await created();
		expect(await actions.deleteInfraWebhook("app-a", endpoint.id)).toEqual({
			success: true,
		});
		expect(endpoints()[0]?.deletedAt).toBeInstanceOf(Date);
		expect(
			await actions.rotateInfraWebhookSecret("app-a", endpoint.id),
		).toMatchObject({ status: 404, code: "webhook_not_found" });
	});

	it("stops at the shared rate limit before writing", async () => {
		context.limited = true;
		const result = await actions.createInfraWebhook("app-a", {
			url: URL_A,
			events: ["video.ready"],
		});
		expect(result).toMatchObject({ status: 429, code: "rate_limited" });
		expect(endpoints()).toHaveLength(0);
	});
});

function escape(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
