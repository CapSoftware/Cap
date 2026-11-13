import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	queries: 0,
	keyRows: [] as { appId: string }[],
	store: {
		createWebhookEndpoint: vi.fn(),
		deleteWebhookEndpoint: vi.fn(),
		getWebhookEndpoint: vi.fn(),
		listWebhookEndpoints: vi.fn(),
		sendWebhookTestEvent: vi.fn(),
		updateWebhookEndpoint: vi.fn(),
	},
}));

vi.mock("@cap/database", () => {
	const chain = {
		select: () => {
			mocks.queries += 1;
			return chain;
		},
		from: () => chain,
		innerJoin: () => chain,
		leftJoin: () => chain,
		where: () => chain,
		limit: async () => mocks.keyRows,
		update: () => {
			mocks.queries += 1;
			return chain;
		},
		set: () => chain,
		catch: () => chain,
	};
	return { db: () => chain };
});
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@cap/database/auth/domain-utils", () => ({
	isBlockedAccountEmail: () => false,
}));
vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));
vi.mock("@cap/env", () => ({
	NODE_ENV: "production",
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
}));
vi.mock("@/lib/developer-key-hash", () => ({
	hashKey: async (key: string) => `hash:${key}`,
}));
vi.mock("@/lib/developer-webhooks", () => ({
	...mocks.store,
	serializeWebhookEndpoint: (endpoint: unknown) => endpoint,
	serializeWebhookTestResult: (eventId: string) => ({ eventId }),
}));

const { app } = await import("@/app/api/developer/v1/[...route]/webhooks");

const ROUTES = [
	["GET", "/"],
	["POST", "/"],
	["GET", "/wh-1"],
	["PATCH", "/wh-1"],
	["DELETE", "/wh-1"],
	["POST", "/wh-1/test"],
] as const;

const call = (method: string, path: string, headers: Record<string, string>) =>
	app.request(path, {
		method,
		headers: { "Content-Type": "application/json", ...headers },
		body:
			method === "POST" || method === "PATCH"
				? JSON.stringify({ url: "https://hooks.example.com/cap" })
				: undefined,
	});

beforeEach(() => {
	mocks.queries = 0;
	mocks.keyRows = [{ appId: "app-1" }];
	for (const mock of Object.values(mocks.store)) mock.mockReset();
});

describe("webhook routes and a bad key", () => {
	it.each([
		["no key", {}],
		["a public key", { Authorization: "Bearer cpk_public_key" }],
		["an upload token", { Authorization: "Bearer cut_upload_token" }],
		["an agent token", { Authorization: "Bearer cap_cli_token" }],
		["a signing secret", { Authorization: "Bearer cws_signing_secret" }],
		["a malformed header", { Authorization: "csk_valid_key" }],
	])("refuses %s without a single database query", async (_label, headers) => {
		for (const [method, path] of ROUTES) {
			const response = await call(method, path, headers);
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({
				code: "invalid_secret_key",
			});
		}
		expect(mocks.queries).toBe(0);
		for (const mock of Object.values(mocks.store)) {
			expect(mock).not.toHaveBeenCalled();
		}
	});

	it("refuses an unknown or revoked secret key before reaching any endpoint", async () => {
		mocks.keyRows = [];
		for (const [method, path] of ROUTES) {
			const response = await call(method, path, {
				Authorization: "Bearer csk_revoked",
			});
			expect(response.status).toBe(401);
		}
		expect(mocks.queries).toBe(ROUTES.length);
		for (const mock of Object.values(mocks.store)) {
			expect(mock).not.toHaveBeenCalled();
		}
	});

	it("passes the app that owns the key to every call", async () => {
		mocks.keyRows = [{ appId: "app-from-key" }];
		mocks.store.listWebhookEndpoints.mockResolvedValue({
			endpoints: [],
			hasMore: false,
		});
		mocks.store.getWebhookEndpoint.mockResolvedValue(null);
		const missing = {
			ok: false,
			status: 404,
			code: "webhook_not_found",
			message: "Webhook endpoint not found",
			hint: "",
		};
		mocks.store.createWebhookEndpoint.mockResolvedValue(missing);
		mocks.store.updateWebhookEndpoint.mockResolvedValue(missing);
		mocks.store.deleteWebhookEndpoint.mockResolvedValue(missing);
		mocks.store.sendWebhookTestEvent.mockResolvedValue(missing);

		for (const [method, path] of ROUTES) {
			await call(method, path, { Authorization: "Bearer csk_valid_key" });
		}
		for (const mock of Object.values(mocks.store)) {
			expect(mock).toHaveBeenCalledTimes(1);
			expect(mock.mock.calls[0]?.[0]).toBe("app-from-key");
		}
	});
});
