import { createServer, type IncomingMessage, type Server } from "node:http";
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

const context = vi.hoisted(() => ({
	fake: null as null | {
		db: unknown;
		rows: (table: object) => Record<string, unknown>[];
		seed: (
			table: object,
			row: Record<string, unknown>,
		) => Record<string, unknown>;
		reset: () => void;
	},
	appDeleted: false,
}));

vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	const { createWebhookFakeDatabase, webhookEndpointDefaults } = await import(
		"./developer-webhook-fake-db"
	);
	const fake = createWebhookFakeDatabase(
		new Map([[schema.developerWebhookEndpoints, webhookEndpointDefaults]]),
		{ joined: () => !context.appDeleted },
	);
	context.fake = fake;
	return { db: () => fake.db };
});
vi.mock("@cap/database/crypto", () => ({
	encrypt: async (text: string) => `sealed:${text}`,
	decrypt: async (text: string) => text.replace(/^sealed:/, ""),
}));
vi.mock("@cap/env", () => ({
	NODE_ENV: "test",
	buildEnv: {},
	serverEnv: () => ({}),
}));
// The production transport refuses loopback, so the local server is reached
// through a name this lookup pins to it.
vi.mock("@/lib/s3-endpoint-policy", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/s3-endpoint-policy")>();
	const publicOnlyLookup: typeof actual.publicOnlyLookup = (
		_hostname,
		options,
		callback,
	) => {
		if (typeof options === "object" && options.all) {
			callback(null, [{ address: "127.0.0.1", family: 4 }]);
			return;
		}
		callback(null, "127.0.0.1", 4);
	};
	return { ...actual, publicOnlyLookup };
});

const { developerWebhookEndpoints } = await import("@cap/database/schema");
const {
	deliverDeveloperWebhookAttempt,
	recordWebhookDelivery,
	sendDeveloperWebhook,
} = await import("@/lib/developer-webhook-delivery");
const {
	WEBHOOK_DISABLE_AFTER_FAILURES,
	WEBHOOK_DISABLE_AFTER_MS,
	WEBHOOK_DISABLED_BY_FAILURES,
} = await import("@/lib/developer-webhook-events");
const { verifyWebhookSignature } = await import(
	"@/lib/developer-webhook-signature"
);
const { requestPublicOnly } = await import("@/lib/storage-fetch");

const SECRET = "cws_0123456789abcdefghjkmnpqrstvwx";

function fake() {
	if (!context.fake) throw new Error("no database");
	return context.fake;
}

function seedEndpoint(overrides: Record<string, unknown> = {}) {
	return fake().seed(developerWebhookEndpoints, {
		id: "wh-1",
		appId: "app-1",
		url: "https://hooks.example.com/cap",
		secretPrefix: SECRET.slice(0, 12),
		encryptedSecret: `sealed:${SECRET}`,
		...overrides,
	});
}

const endpoint = () => {
	const [row] = fake().rows(developerWebhookEndpoints);
	if (!row) throw new Error("no endpoint");
	return row;
};

const job = {
	endpointId: "wh-1",
	eventId: "evt_1",
	eventType: "video.ready",
	body: JSON.stringify({ id: "evt_1", type: "video.ready", data: {} }),
};

const answers = (status: number) => ({
	isBlocked: async () => false,
	request: vi.fn(async () => new Response("ignored", { status })),
});

beforeEach(() => {
	fake().reset();
	context.appDeleted = false;
});

describe("a customer endpoint over real HTTP", () => {
	let server: Server;
	let origin: string;
	const received: {
		headers: IncomingMessage["headers"];
		body: string;
		method?: string;
	}[] = [];
	const held: IncomingMessage[] = [];

	beforeAll(async () => {
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => {
				received.push({
					headers: req.headers,
					method: req.method,
					body: Buffer.concat(chunks).toString("utf8"),
				});
				if (req.url === "/hang") {
					held.push(req);
					return;
				}
				if (req.url === "/big") {
					res.writeHead(200);
					res.write("x".repeat(64 * 1024));
					held.push(req);
					return;
				}
				if (req.url === "/moved") {
					res.writeHead(307, { location: "/ok" });
					res.end();
					return;
				}
				res.writeHead(req.url === "/down" ? 503 : 200);
				res.end("thanks");
			});
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		for (const req of held) req.socket.destroy();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});

	beforeEach(() => {
		received.length = 0;
	});

	const send = (path: string, timeoutMs?: number) =>
		sendDeveloperWebhook(
			{
				url: `${origin}${path}`,
				secret: SECRET,
				eventId: job.eventId,
				eventType: job.eventType,
				body: job.body,
			},
			{ allowPrivate: true, timeoutMs },
		);

	it("posts the exact body with a signature the receiver can verify", async () => {
		expect(await send("/ok")).toMatchObject({ ok: true, responseStatus: 200 });
		const [request] = received;
		expect(request?.method).toBe("POST");
		expect(request?.body).toBe(job.body);
		expect(request?.headers["content-type"]).toBe("application/json");
		expect(request?.headers["cap-event-id"]).toBe("evt_1");
		expect(request?.headers["cap-event-type"]).toBe("video.ready");
		expect(
			verifyWebhookSignature({
				secret: SECRET,
				body: request?.body ?? "",
				header: String(request?.headers["cap-signature"]),
			}),
		).toBe(true);
	});

	it("reports a server error as a failed delivery", async () => {
		expect(await send("/down")).toMatchObject({
			ok: false,
			errorCode: "http_error",
			responseStatus: 503,
		});
	});

	it("does not follow a redirect", async () => {
		expect(await send("/moved")).toMatchObject({
			ok: false,
			errorCode: "redirect",
			responseStatus: 307,
		});
		expect(received).toHaveLength(1);
	});

	it("gives up on an endpoint that never answers", async () => {
		const started = Date.now();
		expect(await send("/hang", 150)).toMatchObject({
			ok: false,
			errorCode: "timeout",
			responseStatus: null,
		});
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("does not wait for or read a response body that never ends", async () => {
		const started = Date.now();
		expect(await send("/big", 5_000)).toMatchObject({
			ok: true,
			responseStatus: 200,
		});
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	describe("through the transport a production build uses", () => {
		const sendPinned = (path: string, timeoutMs?: number) =>
			sendDeveloperWebhook(
				{
					url: `${origin.replace("127.0.0.1", "hooks.test")}${path}`,
					secret: SECRET,
					eventId: job.eventId,
					eventType: job.eventType,
					body: job.body,
				},
				{ allowPrivate: true, request: requestPublicOnly, timeoutMs },
			);

		it("posts the exact body with its length and a verifiable signature", async () => {
			expect(await sendPinned("/ok")).toMatchObject({
				ok: true,
				responseStatus: 200,
			});
			const [request] = received;
			expect(request?.method).toBe("POST");
			expect(request?.body).toBe(job.body);
			expect(request?.headers["content-length"]).toBe(
				String(Buffer.byteLength(job.body)),
			);
			expect(request?.headers.host).toContain("hooks.test");
			expect(
				verifyWebhookSignature({
					secret: SECRET,
					body: request?.body ?? "",
					header: String(request?.headers["cap-signature"]),
				}),
			).toBe(true);
		});

		it("reports a server error and does not follow a redirect", async () => {
			expect(await sendPinned("/down")).toMatchObject({
				ok: false,
				errorCode: "http_error",
				responseStatus: 503,
			});
			expect(await sendPinned("/moved")).toMatchObject({
				ok: false,
				errorCode: "redirect",
				responseStatus: 307,
			});
			expect(received).toHaveLength(2);
		});

		it("gives up on an endpoint that never answers", async () => {
			const started = Date.now();
			expect(await sendPinned("/hang", 150)).toMatchObject({
				ok: false,
				errorCode: "timeout",
			});
			expect(Date.now() - started).toBeLessThan(2_000);
		});

		it("does not wait for or read a response body that never ends", async () => {
			const started = Date.now();
			expect(await sendPinned("/big", 5_000)).toMatchObject({
				ok: true,
				responseStatus: 200,
			});
			expect(Date.now() - started).toBeLessThan(2_000);
		});
	});

	it("reports a closed port as a failed connection", async () => {
		const result = await sendDeveloperWebhook(
			{ ...job, url: "http://127.0.0.1:1/cap", secret: SECRET },
			{ allowPrivate: true },
		);
		expect(result).toMatchObject({
			ok: false,
			errorCode: "connection_failed",
		});
	});
});

describe("one delivery attempt", () => {
	it("delivers, records the result and clears the failure streak", async () => {
		seedEndpoint({
			consecutiveFailures: 4,
			failingSince: new Date("2026-11-10T00:00:00Z"),
		});
		const guards = answers(200);

		expect(await deliverDeveloperWebhookAttempt(job, guards)).toBe("delivered");

		expect(guards.request).toHaveBeenCalledTimes(1);
		expect(endpoint()).toMatchObject({
			lastDeliveryStatus: "succeeded",
			lastResponseStatus: 200,
			lastErrorCode: null,
			consecutiveFailures: 0,
			failingSince: null,
			enabled: true,
		});
		expect(endpoint().lastDeliveryAt).toBeInstanceOf(Date);
	});

	it("asks for a retry and counts the failure", async () => {
		seedEndpoint();
		expect(await deliverDeveloperWebhookAttempt(job, answers(500))).toBe(
			"retry",
		);
		expect(endpoint()).toMatchObject({
			lastDeliveryStatus: "failed",
			lastResponseStatus: 500,
			lastErrorCode: "http_error",
			consecutiveFailures: 1,
			enabled: true,
		});
		expect(endpoint().failingSince).toBeInstanceOf(Date);
	});

	it("keeps the start of a failure streak across later failures", async () => {
		const failingSince = new Date("2026-11-10T00:00:00Z");
		seedEndpoint({ consecutiveFailures: 2, failingSince });
		await deliverDeveloperWebhookAttempt(job, answers(500));
		expect(endpoint()).toMatchObject({ consecutiveFailures: 3, failingSince });
	});

	it("leaves the endpoint's updatedAt alone", async () => {
		const seeded = seedEndpoint();
		const before = seeded.updatedAt;
		await deliverDeveloperWebhookAttempt(job, answers(500));
		await deliverDeveloperWebhookAttempt(job, answers(200));
		expect(endpoint().updatedAt).toBe(before);
	});

	it.each([
		["was deleted", { deletedAt: new Date() }],
		["was disabled", { enabled: false }],
		["no longer wants the event", { events: ["video.errored"] }],
	])("drops the delivery when the endpoint %s", async (_label, overrides) => {
		seedEndpoint(overrides);
		const guards = answers(200);
		expect(await deliverDeveloperWebhookAttempt(job, guards)).toBe("dropped");
		expect(guards.request).not.toHaveBeenCalled();
		expect(endpoint().lastDeliveryAt).toBeNull();
	});

	it("drops the delivery when the endpoint is gone or its app was deleted", async () => {
		const guards = answers(200);
		expect(await deliverDeveloperWebhookAttempt(job, guards)).toBe("dropped");
		seedEndpoint();
		context.appDeleted = true;
		expect(await deliverDeveloperWebhookAttempt(job, guards)).toBe("dropped");
		expect(guards.request).not.toHaveBeenCalled();
	});
});

describe("disabling an endpoint that keeps failing", () => {
	const failed = {
		ok: false as const,
		responseStatus: 500,
		errorCode: "http_error" as const,
		durationMs: 5,
	};
	const now = new Date("2026-11-20T12:00:00Z");
	const longAgo = new Date(now.getTime() - WEBHOOK_DISABLE_AFTER_MS - 1_000);

	it("disables after many failures over several days", async () => {
		seedEndpoint({
			consecutiveFailures: WEBHOOK_DISABLE_AFTER_FAILURES - 1,
			failingSince: longAgo,
		});
		await recordWebhookDelivery("wh-1", failed, {
			countsTowardStreak: true,
			now,
		});
		expect(endpoint()).toMatchObject({
			enabled: false,
			disabledReason: WEBHOOK_DISABLED_BY_FAILURES,
			consecutiveFailures: WEBHOOK_DISABLE_AFTER_FAILURES,
		});
	});

	it("keeps an endpoint with many failures in a short time", async () => {
		seedEndpoint({
			consecutiveFailures: 500,
			failingSince: new Date(now.getTime() - 60 * 60 * 1000),
		});
		await recordWebhookDelivery("wh-1", failed, {
			countsTowardStreak: true,
			now,
		});
		expect(endpoint()).toMatchObject({ enabled: true, disabledReason: null });
	});

	it("keeps an endpoint with a few failures over a long time", async () => {
		seedEndpoint({ consecutiveFailures: 3, failingSince: longAgo });
		await recordWebhookDelivery("wh-1", failed, {
			countsTowardStreak: true,
			now,
		});
		expect(endpoint()).toMatchObject({ enabled: true, consecutiveFailures: 4 });
	});

	it("never counts a test event towards the streak", async () => {
		seedEndpoint({
			consecutiveFailures: WEBHOOK_DISABLE_AFTER_FAILURES + 5,
			failingSince: longAgo,
		});
		await recordWebhookDelivery("wh-1", failed, {
			countsTowardStreak: false,
			now,
		});
		expect(endpoint()).toMatchObject({
			enabled: true,
			consecutiveFailures: WEBHOOK_DISABLE_AFTER_FAILURES + 5,
			lastDeliveryStatus: "failed",
			lastErrorCode: "http_error",
		});
	});
});
