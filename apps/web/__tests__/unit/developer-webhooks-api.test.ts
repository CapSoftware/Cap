import { beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
	fake: null as null | {
		db: unknown;
		rows: (table: object) => Record<string, unknown>[];
		reset: () => void;
	},
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
vi.mock("@cap/env", () => ({
	NODE_ENV: "production",
	buildEnv: {
		NEXT_PUBLIC_IS_CAP: "true",
		NEXT_PUBLIC_WEB_URL: "https://cap.so",
	},
	serverEnv: () => ({ DATABASE_ENCRYPTION_KEY: "ab".repeat(32) }),
}));
vi.mock("@/app/api/utils", async () => {
	const { createMiddleware } = await import("hono/factory");
	const apps: Record<string, string> = {
		csk_app_a: "app-a",
		csk_app_b: "app-b",
	};
	return {
		withDeveloperSecretAuth: createMiddleware(async (c, next) => {
			const key = c.req.header("authorization")?.split(" ")[1] ?? "";
			const appId = apps[key];
			if (!appId) return c.json({ code: "invalid_secret_key" }, 401);
			c.set("developerAppId", appId);
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

const { developerWebhookEndpoints } = await import("@cap/database/schema");
const { decrypt } = await import("@cap/database/crypto");
const { app } = await import("@/app/api/developer/v1/[...route]/webhooks");
const { verifyWebhookSignature } = await import(
	"@/lib/developer-webhook-signature"
);

const A = { Authorization: "Bearer csk_app_a" };
const B = { Authorization: "Bearer csk_app_b" };

const send = (
	method: string,
	path: string,
	headers: Record<string, string>,
	body?: unknown,
) =>
	app.request(path, {
		method,
		headers: {
			...headers,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

async function create(
	headers: Record<string, string> = A,
	body: Record<string, unknown> = { url: "https://hooks.example.com/cap" },
) {
	const response = await send("POST", "/", headers, body);
	return {
		status: response.status,
		body: (await response.json()) as {
			data: Record<string, unknown> & { id: string; secret: string };
			code?: string;
			hint?: string;
		},
	};
}

const rows = () => context.fake?.rows(developerWebhookEndpoints) ?? [];

beforeEach(() => {
	context.fake?.reset();
	context.resolved = ["93.184.216.34"];
	context.request = null;
});

describe("creating a webhook endpoint", () => {
	it("returns the signing secret once and stores it encrypted", async () => {
		const created = await create();
		expect(created.status).toBe(200);
		const { id, secret } = created.body.data;
		expect(secret).toMatch(/^cws_[0-9a-z]{30}$/);
		expect(created.body.data).toMatchObject({
			url: "https://hooks.example.com/cap",
			events: ["video.ready", "video.errored"],
			enabled: true,
			disabledReason: null,
			secretPrefix: secret.slice(0, 12),
			lastDeliveryAt: null,
			consecutiveFailures: 0,
		});

		const [row] = rows();
		expect(row?.encryptedSecret).not.toContain(secret);
		expect(await decrypt(String(row?.encryptedSecret))).toBe(secret);

		for (const response of [
			await send("GET", `/${id}`, A),
			await send("GET", "/", A),
			await send("PATCH", `/${id}`, A, { enabled: false }),
			await send("POST", `/${id}/test`, A),
		]) {
			const text = await response.text();
			expect(text).not.toContain(secret);
			expect(text).not.toContain("encryptedSecret");
		}
	});

	it("takes the events and enabled flag it is given", async () => {
		const created = await create(A, {
			url: "https://hooks.example.com/cap",
			events: ["video.errored"],
			enabled: false,
		});
		expect(created.body.data).toMatchObject({
			events: ["video.errored"],
			enabled: false,
		});
	});

	it.each([
		["an unknown field", { url: "https://hooks.example.com/cap", name: "x" }],
		["a missing url", {}],
		["an unknown event", { url: "https://a.example/x", events: ["video.up"] }],
		["no events", { url: "https://a.example/x", events: [] }],
		[
			"an event listed twice",
			{ url: "https://a.example/x", events: ["video.ready", "video.ready"] },
		],
		[
			"a secret of the caller's choosing",
			{ url: "https://a.example/x", secret: "s" },
		],
	])("refuses %s", async (_label, body) => {
		const created = await create(A, body);
		expect(created.status).toBe(400);
		expect(created.body.code).toBe("invalid_request");
		expect(rows()).toHaveLength(0);
	});

	it.each([
		["http", "http://hooks.example.com/cap"],
		["a private address", "https://10.0.0.8/cap"],
		["the metadata address", "https://169.254.169.254/latest"],
		["a mapped loopback address", "https://[::ffff:127.0.0.1]/cap"],
		["credentials", "https://user:pass@hooks.example.com/cap"],
		["another port", "https://hooks.example.com:8080/cap"],
	])("refuses a URL with %s", async (_label, url) => {
		const created = await create(A, { url });
		expect(created.status).toBe(400);
		expect(created.body.code).toBe("invalid_webhook_url");
		expect(rows()).toHaveLength(0);
	});

	it("refuses a URL that is too long once encoded, on create and on update", async () => {
		const accented = `https://hooks.example.com/${"é".repeat(400)}`;
		const created = await create(A, { url: accented });
		expect(created.status).toBe(400);
		expect(created.body.code).toBe("invalid_webhook_url");
		expect(rows()).toHaveLength(0);

		const { id } = (await create(A)).body.data;
		const updated = await send("PATCH", `/${id}`, A, { url: accented });
		expect(updated.status).toBe(400);
		expect(rows()[0]?.url).toBe("https://hooks.example.com/cap");
	});

	it("refuses a name that resolves to a private address", async () => {
		context.resolved = ["192.168.1.20"];
		const created = await create();
		expect(created.status).toBe(400);
		expect(created.body.code).toBe("invalid_webhook_url");
		expect(rows()).toHaveLength(0);
	});

	it("stops at five endpoints per app, and counts each app on its own", async () => {
		for (let i = 0; i < 5; i++) {
			expect((await create(A)).status).toBe(200);
		}
		const sixth = await create(A);
		expect(sixth.status).toBe(409);
		expect(sixth.body.code).toBe("webhook_limit_reached");
		expect(rows()).toHaveLength(5);

		expect((await create(B)).status).toBe(200);
	});

	it("does not let simultaneous requests pass the limit", async () => {
		const results = await Promise.all(
			Array.from({ length: 8 }, () => create(A)),
		);
		expect(results.filter((result) => result.status === 200)).toHaveLength(5);
		expect(rows()).toHaveLength(5);
	});

	it("frees a place when an endpoint is deleted", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) ids.push((await create(A)).body.data.id);
		expect((await send("DELETE", `/${ids[0]}`, A)).status).toBe(200);
		expect((await create(A)).status).toBe(200);
	});
});

describe("reading and changing webhook endpoints", () => {
	it("lists an app's endpoints newest first with pagination", async () => {
		const first = (await create(A)).body.data.id;
		const second = (await create(A)).body.data.id;
		const list = await (await send("GET", "/?limit=1", A)).json();
		expect(list.data.map((row: { id: string }) => row.id)).toEqual([second]);
		expect(list.pagination).toEqual({ limit: 1, offset: 0, hasMore: true });
		const next = await (await send("GET", "/?limit=1&offset=1", A)).json();
		expect(next.data.map((row: { id: string }) => row.id)).toEqual([first]);
		expect(next.pagination.hasMore).toBe(false);
	});

	it("refuses an unknown query parameter on the list", async () => {
		const response = await send("GET", "/?userId=u1", A);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "unknown_parameter" });
	});

	it("updates url, events and enabled", async () => {
		const { id } = (await create(A)).body.data;
		const response = await send("PATCH", `/${id}`, A, {
			url: "https://other.example.com/hook",
			events: ["video.ready"],
			enabled: false,
		});
		expect(response.status).toBe(200);
		expect((await response.json()).data).toMatchObject({
			url: "https://other.example.com/hook",
			events: ["video.ready"],
			enabled: false,
		});
	});

	it("refuses an update with nothing in it, an unknown field or a bad URL", async () => {
		const { id } = (await create(A)).body.data;
		expect((await send("PATCH", `/${id}`, A, {})).status).toBe(400);
		expect((await send("PATCH", `/${id}`, A, { secret: "x" })).status).toBe(
			400,
		);
		const bad = await send("PATCH", `/${id}`, A, {
			url: "https://127.0.0.1/x",
		});
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ code: "invalid_webhook_url" });
		expect(rows()[0]?.url).toBe("https://hooks.example.com/cap");
	});

	it("turns a disabled endpoint back on with a clean failure streak", async () => {
		const { id } = (await create(A)).body.data;
		Object.assign(rows()[0] ?? {}, {
			enabled: false,
			disabledReason: "delivery_failures",
			consecutiveFailures: 31,
			failingSince: new Date("2026-11-01T00:00:00Z"),
		});
		const response = await send("PATCH", `/${id}`, A, { enabled: true });
		expect((await response.json()).data).toMatchObject({
			enabled: true,
			disabledReason: null,
			consecutiveFailures: 0,
		});
		expect(rows()[0]?.failingSince).toBeNull();
	});

	it("deletes an endpoint, and a second delete still succeeds", async () => {
		const { id } = (await create(A)).body.data;
		expect(await (await send("DELETE", `/${id}`, A)).json()).toEqual({
			success: true,
		});
		expect((await send("GET", `/${id}`, A)).status).toBe(404);
		expect((await send("DELETE", `/${id}`, A)).status).toBe(200);
		expect((await send("GET", "/", A)).status).toBe(200);
		expect((await (await send("GET", "/", A)).json()).data).toEqual([]);
	});
});

describe("one app cannot reach another app's endpoints", () => {
	it("answers not found for every call made with another app's key", async () => {
		const { id } = (await create(A)).body.data;
		context.request = async () => new Response(null, { status: 200 });

		const attempts = [
			await send("GET", `/${id}`, B),
			await send("PATCH", `/${id}`, B, { enabled: false }),
			await send("PATCH", `/${id}`, B, { url: "https://evil.example.com/x" }),
			await send("POST", `/${id}/rotate-secret`, B),
			await send("DELETE", `/${id}`, B),
			await send("POST", `/${id}/test`, B),
		];
		for (const response of attempts) {
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({
				code: "webhook_not_found",
			});
		}

		expect((await (await send("GET", "/", B)).json()).data).toEqual([]);
		expect(rows()[0]).toMatchObject({
			id,
			appId: "app-a",
			url: "https://hooks.example.com/cap",
			enabled: true,
			deletedAt: null,
			lastDeliveryAt: null,
		});
		expect((await send("GET", `/${id}`, A)).status).toBe(200);
	});

	it("refuses a call with no valid key", async () => {
		const { id } = (await create(A)).body.data;
		for (const [method, path] of [
			["GET", "/"],
			["GET", `/${id}`],
			["PATCH", `/${id}`],
			["DELETE", `/${id}`],
			["POST", `/${id}/rotate-secret`],
			["POST", `/${id}/test`],
			["POST", "/"],
		] as const) {
			expect((await send(method, path, {})).status).toBe(401);
		}
	});
});

describe("rotating the signing secret", () => {
	it("returns a new secret once, stores it encrypted and signs with it from then on", async () => {
		const { id, secret: oldSecret } = (await create(A)).body.data;
		const response = await send("POST", `/${id}/rotate-secret`, A);
		expect(response.status).toBe(200);
		const { data } = await response.json();
		expect(data.secret).toMatch(/^cws_[0-9a-z]{30}$/);
		expect(data.secret).not.toBe(oldSecret);
		expect(data).toMatchObject({ id, secretPrefix: data.secret.slice(0, 12) });

		const [row] = rows();
		expect(await decrypt(String(row?.encryptedSecret))).toBe(data.secret);
		for (const later of [
			await send("GET", `/${id}`, A),
			await send("GET", "/", A),
		]) {
			const text = await later.text();
			expect(text).not.toContain(data.secret);
			expect(text).not.toContain(oldSecret);
		}

		const seen: RequestInit[] = [];
		context.request = async (_url, init) => {
			seen.push(init);
			return new Response(null, { status: 204 });
		};
		await send("POST", `/${id}/test`, A);
		const header = new Headers(seen[0]?.headers).get("cap-signature");
		const body = String(seen[0]?.body);
		expect(verifyWebhookSignature({ secret: data.secret, body, header })).toBe(
			true,
		);
		expect(verifyWebhookSignature({ secret: oldSecret, body, header })).toBe(
			false,
		);
	});

	it("keeps the endpoint's settings and delivery state", async () => {
		const { id } = (await create(A)).body.data;
		await send("PATCH", `/${id}`, A, {
			url: "https://hooks.example.com/other",
			events: ["video.errored"],
			enabled: false,
		});
		const before = rows()[0];
		await send("POST", `/${id}/rotate-secret`, A);
		expect(rows()[0]).toMatchObject({
			url: before?.url,
			events: before?.events,
			enabled: false,
			consecutiveFailures: before?.consecutiveFailures,
		});
	});

	it("answers not found for a deleted endpoint", async () => {
		const { id } = (await create(A)).body.data;
		await send("DELETE", `/${id}`, A);
		const encrypted = rows()[0]?.encryptedSecret;
		const response = await send("POST", `/${id}/rotate-secret`, A);
		expect(response.status).toBe(404);
		expect(rows()[0]?.encryptedSecret).toBe(encrypted);
	});
});

describe("sending a test event", () => {
	it("sends one signed webhook.test event and reports what came back", async () => {
		const { id, secret } = (await create(A)).body.data;
		const seen: { url: string; init: RequestInit }[] = [];
		context.request = async (url, init) => {
			seen.push({ url, init });
			return new Response("never shown to the caller", { status: 200 });
		};

		const response = await send("POST", `/${id}/test`, A);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain("never shown");
		const { data } = JSON.parse(text);
		expect(data).toMatchObject({
			type: "webhook.test",
			delivered: true,
			responseStatus: 200,
			errorCode: null,
		});
		expect(data.eventId).toMatch(/^evt_test_/);

		expect(seen).toHaveLength(1);
		const headers = new Headers(seen[0]?.init.headers);
		const body = String(seen[0]?.init.body);
		expect(JSON.parse(body)).toMatchObject({
			id: data.eventId,
			type: "webhook.test",
			data: { webhookId: id },
		});
		expect(headers.get("cap-event-type")).toBe("webhook.test");
		expect(
			verifyWebhookSignature({
				secret,
				body,
				header: headers.get("cap-signature"),
			}),
		).toBe(true);
		expect(rows()[0]).toMatchObject({
			lastDeliveryStatus: "succeeded",
			lastResponseStatus: 200,
		});
	});

	it("reports a failing endpoint without counting it towards disabling", async () => {
		const { id } = (await create(A)).body.data;
		context.request = async () => new Response("boom", { status: 500 });
		const { data } = await (await send("POST", `/${id}/test`, A)).json();
		expect(data).toMatchObject({
			delivered: false,
			responseStatus: 500,
			errorCode: "http_error",
		});
		expect(rows()[0]).toMatchObject({
			consecutiveFailures: 0,
			failingSince: null,
			lastDeliveryStatus: "failed",
		});
	});

	it("sends nothing when the URL now resolves to a private address", async () => {
		const { id } = (await create(A)).body.data;
		context.resolved = ["10.0.0.9"];
		const { data } = await (await send("POST", `/${id}/test`, A)).json();
		expect(data).toMatchObject({
			delivered: false,
			errorCode: "private_address",
		});
	});
});
