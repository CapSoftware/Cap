import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const API_KEY = "0123456789abcdef0123456789abcdef0123";
const WEBHOOK_URL = "https://discord.com/api/webhooks/1/token";

const mocks = vi.hoisted(() => ({
	getCurrentUser: vi.fn(),
	requestsPerKey: new Map<string, number>(),
	rateLimitCalls: [] as Array<{ ruleId: string; key?: string }>,
	webhookStatus: 200,
	stripe: {
		customers: { list: vi.fn(), update: vi.fn(), create: vi.fn() },
		subscriptions: { list: vi.fn() },
		checkout: { sessions: { create: vi.fn() } },
	},
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
	getCurrentUser: mocks.getCurrentUser,
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
	serverEnv: () => ({
		DISCORD_LOGS_WEBHOOK_URL: WEBHOOK_URL,
		WEB_URL: "https://cap.so",
	}),
	buildEnv: {
		NEXT_PUBLIC_WEB_URL: "https://cap.so",
		NEXT_PUBLIC_IS_CAP: "true",
	},
}));

vi.mock("@cap/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/utils")>();
	return {
		...actual,
		isValidStripePlanPriceId: (id: string) => id === "price_pro",
		STRIPE_AVAILABLE: () => true,
		stripe: () => mocks.stripe,
	};
});

vi.mock("@cap/web-backend", () => ({ ImageUploads: {} }));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/server-analytics", () => ({ trackServerEvent: vi.fn() }));

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
		mocks.getCurrentUser.mockResolvedValue(null);
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

describe.each(["desktop", "mobile"] as const)(
	"POST /api/desktop/subscribe from %s",
	(platform) => {
		const user = {
			id: "user-1",
			email: "person@example.com",
			stripeCustomerId: "cus_1",
			stripeSubscriptionStatus: null,
			thirdPartyStripeSubscriptionId: null,
		};
		const subscribe = () =>
			app.request("https://cap.so/api/desktop/subscribe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					priceId: "price_pro",
					...(platform === "mobile" ? { platform } : {}),
				}),
			});

		beforeEach(() => {
			mocks.getCurrentUser.mockResolvedValue(user);
			mocks.stripe.subscriptions.list.mockReset();
			mocks.stripe.subscriptions.list.mockResolvedValue({ data: [] });
			mocks.stripe.checkout.sessions.create.mockResolvedValue({
				url: "https://pay.cap.so/session",
			});
		});

		it.each(["active", "trialing", "past_due"])(
			"blocks a second purchase when Stripe already has a %s Pro subscription",
			async (status) => {
				mocks.stripe.subscriptions.list.mockResolvedValue({
					data: [{ status, metadata: {} }],
				});

				const response = await subscribe();

				expect(response.status).toBe(400);
				expect(await response.json()).toEqual({
					error: true,
					subscription: true,
				});
				expect(mocks.stripe.subscriptions.list).toHaveBeenCalledWith({
					customer: "cus_1",
					limit: 100,
				});
				expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
			},
		);

		it("checks the recovered Stripe customer before allowing another purchase", async () => {
			mocks.getCurrentUser.mockResolvedValue({
				...user,
				stripeCustomerId: null,
			});
			mocks.stripe.customers.list.mockResolvedValue({
				data: [{ id: "cus_recovered", metadata: {} }],
			});
			mocks.stripe.customers.update.mockResolvedValue({ id: "cus_recovered" });
			mocks.stripe.subscriptions.list.mockResolvedValue({
				data: [{ status: "active", metadata: {} }],
			});

			const response = await subscribe();

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error: true,
				subscription: true,
			});
			expect(mocks.stripe.subscriptions.list).toHaveBeenCalledWith({
				customer: "cus_recovered",
				limit: 100,
			});
			expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
		});

		it("does not create checkout when the Stripe check fails", async () => {
			mocks.stripe.subscriptions.list.mockRejectedValue(
				new Error("Stripe unavailable"),
			);

			expect((await subscribe()).status).toBe(500);
			expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
		});

		it("allows a purchase after Pro ends or when only add-ons remain", async () => {
			mocks.stripe.subscriptions.list.mockResolvedValue({
				data: [
					{ status: "canceled", metadata: {} },
					{ status: "active", metadata: { type: "signed_baa" } },
					{ status: "active", metadata: { type: "saml_sso" } },
				],
			});

			const response = await subscribe();

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				url: "https://pay.cap.so/session",
			});
			expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
				expect.objectContaining({
					customer: "cus_1",
					metadata: { platform, dubCustomerId: "user-1" },
				}),
			);
		});
	},
);
