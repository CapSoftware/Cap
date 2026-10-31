import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const API_KEY = "0123456789abcdef0123456789abcdef0123";
const WEBHOOK_URL = "https://discord.com/api/webhooks/1/token";

const mocks = vi.hoisted(() => ({
	requestsPerKey: new Map<string, number>(),
	rateLimitCalls: [] as Array<{ ruleId: string; key?: string }>,
	webhookStatus: 200,
}));

const REQUESTS_PER_KEY_LIMIT = 10;

vi.mock("server-only", () => ({}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				leftJoin: () => ({
					where: async () => [
						{
							users: {
								id: "user-1",
								email: "person@example.com",
							},
						},
					],
				}),
			}),
		}),
		update: () => ({
			set: () => ({ where: async () => undefined }),
		}),
	}),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(async () => null),
}));

vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));

vi.mock("@cap/database/auth/domain-utils", () => ({
	isBlockedAccountEmail: () => false,
}));

vi.mock("@cap/database/emails/config", () => ({ sendEmail: vi.fn() }));
vi.mock("@cap/database/emails/feedback", () => ({ Feedback: vi.fn() }));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ DISCORD_LOGS_WEBHOOK_URL: WEBHOOK_URL }),
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
}));

vi.mock("@cap/utils", () => ({
	isProSubscription: vi.fn(),
	isValidStripePlanPriceId: vi.fn(),
	STRIPE_AVAILABLE: () => false,
	stripe: vi.fn(),
	userIsPro: vi.fn(),
}));

vi.mock("@cap/web-backend", () => ({ ImageUploads: {} }));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/server-analytics", () => ({ trackServerEvent: vi.fn() }));
vi.mock("@/lib/mobile-checkout", () => ({ getCheckoutRedirectUrls: vi.fn() }));

vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: { DESKTOP_LOGS: "rl_desktop_logs" },
	isRateLimited: vi.fn(
		async (ruleId: string, opts?: { key?: string; headers?: Headers }) => {
			mocks.rateLimitCalls.push({ ruleId, key: opts?.key });
			const bucket = opts?.key ?? opts?.headers?.get("x-real-ip") ?? "none";
			const count = (mocks.requestsPerKey.get(bucket) ?? 0) + 1;
			mocks.requestsPerKey.set(bucket, count);
			return count > REQUESTS_PER_KEY_LIMIT;
		},
	),
}));

const { corsMiddleware } = await import("@/app/api/utils");
const root = await import("@/app/api/desktop/[...route]/root");

const app = new Hono()
	.basePath("/api/desktop")
	.use(corsMiddleware)
	.route("/", root.app);

const uploadLogs = (
	fields: Record<string, string>,
	{ ip = "203.0.113.1", token }: { ip?: string; token?: string } = {},
) => {
	const form = new FormData();
	for (const [name, value] of Object.entries(fields)) form.append(name, value);
	return app.request("https://cap.so/api/desktop/logs", {
		method: "POST",
		body: form,
		headers: {
			"x-real-ip": ip,
			origin: "tauri://localhost",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
	});
};

const webhookCalls = () =>
	vi
		.mocked(fetch)
		.mock.calls.filter(([input]) => String(input).startsWith(WEBHOOK_URL));

const lastWebhookForm = () => {
	const [, init] = webhookCalls().at(-1) ?? [];
	const body = init?.body;
	if (!(body instanceof FormData)) throw new Error("Missing webhook form");
	return body;
};

describe("POST /api/desktop/logs", () => {
	beforeEach(() => {
		mocks.requestsPerKey.clear();
		mocks.rateLimitCalls = [];
		mocks.webhookStatus = 200;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("{}", {
						status: mocks.webhookStatus,
						statusText: mocks.webhookStatus === 200 ? "OK" : "Bad",
					}),
			),
		);
	});

	it("stops forwarding to the webhook once one address passes the limit", async () => {
		for (let index = 0; index < REQUESTS_PER_KEY_LIMIT; index++) {
			const response = await uploadLogs({ log: `log ${index}`, os: "macos" });
			expect(response.status).toBe(200);
		}

		const limited = await uploadLogs({ log: "one more", os: "macos" });

		expect(limited.status).toBe(429);
		expect(limited.headers.get("access-control-allow-origin")).toBe(
			"tauri://localhost",
		);
		expect(webhookCalls()).toHaveLength(REQUESTS_PER_KEY_LIMIT);
		expect(mocks.rateLimitCalls.at(-1)).toEqual({
			ruleId: "rl_desktop_logs",
			key: undefined,
		});

		const otherAddress = await uploadLogs(
			{ log: "different address" },
			{ ip: "198.51.100.7" },
		);
		expect(otherAddress.status).toBe(200);
		expect(webhookCalls()).toHaveLength(REQUESTS_PER_KEY_LIMIT + 1);
	});

	it("limits signed-in uploads per user and still attaches the user", async () => {
		const response = await uploadLogs(
			{ log: "signed in", version: "0.6.2" },
			{ token: API_KEY },
		);

		expect(response.status).toBe(200);
		expect(mocks.rateLimitCalls).toEqual([
			{ ruleId: "rl_desktop_logs", key: "desktop-logs:user-1" },
		]);
		const payload = JSON.parse(String(lastWebhookForm().get("payload_json")));
		expect(payload.content).toContain("person@example.com (user-1)");
	});

	it("forwards diagnostics, report and context alongside the log", async () => {
		await uploadLogs({
			log: "with attachments",
			diagnostics: JSON.stringify({ hardware: { cpuCores: 8 } }),
			report: JSON.stringify({ schemaVersion: 1 }),
			context: JSON.stringify({ operations: { records: [] } }),
		});

		const form = lastWebhookForm();
		const log = form.get("files[0]");
		const attachment = form.get("files[1]");
		if (!(log instanceof Blob) || !(attachment instanceof Blob)) {
			throw new Error("Missing attachments");
		}
		expect(await log.text()).toBe("with attachments");
		const parsed = JSON.parse(await attachment.text());
		expect(parsed.diagnostics).toEqual({ hardware: { cpuCores: 8 } });
		expect(parsed.report).toEqual({ schemaVersion: 1 });
		expect(parsed.context).toEqual({ operations: { records: [] } });
	});

	it("still reports a webhook failure as a 500", async () => {
		mocks.webhookStatus = 502;

		const response = await uploadLogs({ log: "webhook down" });

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Failed to upload logs" });
	});

	it("keeps answering desktop preflight requests", async () => {
		const response = await app.request("https://cap.so/api/desktop/logs", {
			method: "OPTIONS",
			headers: {
				origin: "tauri://localhost",
				"access-control-request-method": "POST",
			},
		});

		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe(
			"tauri://localhost",
		);
		expect(mocks.rateLimitCalls).toEqual([]);
	});
});
