import type { DbClient } from "@cap/web-backend/src/Database";
import type { HttpApi } from "@effect/platform";
import type { Context, Layer as EffectLayer } from "effect";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
	signedIn: true,
	limited: false,
	rateLimitCalls: [] as { ruleId: string; key: string | undefined }[],
	dispose: async () => {},
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rate-limit")>()),
	isRateLimited: vi.fn(async (ruleId: string, opts?: { key?: string }) => {
		mocks.rateLimitCalls.push({ ruleId, key: opts?.key });
		return mocks.limited;
	}),
}));

vi.mock("@/lib/server", async () => {
	const { Database, Videos, VideosPolicy } = await import("@cap/web-backend");
	const { HttpAuthMiddleware, Organisation, User } = await import(
		"@cap/web-domain"
	);
	const { HttpApiBuilder, HttpApiError, HttpServer } = await import(
		"@effect/platform"
	);
	const { Effect, Layer, Option } = await import("effect");
	const database = Layer.succeed(
		Database,
		Database.make({
			use: (callback) =>
				Effect.promise(() => callback({} as unknown as DbClient)),
		}),
	);
	const videos = Layer.succeed(
		Videos,
		{} as unknown as Context.Tag.Service<typeof Videos>,
	);
	const policy = Layer.succeed(
		VideosPolicy,
		{} as unknown as Context.Tag.Service<typeof VideosPolicy>,
	);
	const auth = Layer.succeed(
		HttpAuthMiddleware,
		Effect.suspend(() =>
			mocks.signedIn
				? Effect.succeed({
						id: User.UserId.make("user_1"),
						email: "user@example.com",
						activeOrganizationId: Organisation.OrganisationId.make("org"),
						iconUrlOrKey: Option.none(),
					})
				: Effect.fail(new HttpApiError.Unauthorized()),
		),
	);
	return {
		apiToHandler: (
			api: EffectLayer.Layer<
				HttpApi.Api,
				never,
				| Context.Tag.Identifier<typeof Database>
				| Context.Tag.Identifier<typeof Videos>
				| Context.Tag.Identifier<typeof VideosPolicy>
				| Context.Tag.Identifier<typeof HttpAuthMiddleware>
			>,
		) => {
			const handler = api.pipe(
				Layer.provideMerge(auth),
				Layer.provideMerge(database),
				Layer.provideMerge(videos),
				Layer.provideMerge(policy),
				Layer.merge(HttpServer.layerContext),
				HttpApiBuilder.toWebHandler,
			);
			mocks.dispose = handler.dispose;
			return handler.handler;
		},
	};
});

type Forwarded = {
	url: string;
	headers: Record<string, string>;
	body: {
		type: string;
		payload: {
			name: string;
			profileId?: string;
			properties: Record<string, unknown>;
		};
	};
};

describe("mobile usage events", () => {
	let route: typeof import("@/app/api/mobile/[...route]/route");
	let forwarded: Forwarded[] = [];
	let openPanelStatus = 202;
	const NOW = Date.parse("2026-11-12T10:00:00.000Z");

	beforeAll(async () => {
		Object.assign(process.env, {
			NEXT_PUBLIC_WEB_URL: "http://localhost",
			WEB_URL: "http://localhost",
			DATABASE_URL: "mysql://unused:unused@127.0.0.1:3306/unused",
			NEXTAUTH_SECRET: "synthetic-test-secret-that-is-long-enough",
			NEXTAUTH_URL: "http://localhost",
			CAP_AWS_BUCKET: "synthetic",
			CAP_AWS_REGION: "us-east-1",
			CAP_AWS_ACCESS_KEY: "synthetic",
			CAP_AWS_SECRET_KEY: "synthetic",
			NODE_ENV: "test",
			NEXT_PUBLIC_OPENPANEL_CLIENT_ID: "client-id",
			NEXT_PUBLIC_OPENPANEL_API_URL: "https://openpanel.test/",
			OPENPANEL_CLIENT_SECRET: "client-secret",
		});
		route = await import("@/app/api/mobile/[...route]/route");
	});

	beforeEach(() => {
		mocks.signedIn = true;
		mocks.limited = false;
		mocks.rateLimitCalls = [];
		forwarded = [];
		openPanelStatus = 202;
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				forwarded.push({
					url,
					headers: init.headers as Record<string, string>,
					body: JSON.parse(init.body as string),
				});
				return new Response(null, { status: openPanelStatus });
			}),
		);
	});

	afterAll(async () => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		await mocks.dispose();
	});

	const app = {
		version: "1.0.4",
		build: "2026111201",
		os: "26.1",
		device: "phone",
	};
	const post = (body: unknown, ip = "203.0.113.7") =>
		route.POST(
			new Request("http://localhost/api/mobile/events", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-forwarded-for": ip,
					Authorization: "Bearer 0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e",
				},
				body: JSON.stringify(body),
			}),
		);
	const batch = (events: unknown[], sentAt = NOW) => ({ sentAt, app, events });

	it("forwards a batch with the session's user, the device and each event's own time", async () => {
		const response = await post(
			batch([
				{
					name: "app_opened",
					timestamp: NOW - 12_000,
					properties: { signed_in: true },
				},
				{
					name: "recording_started",
					timestamp: NOW - 4_000,
					properties: { mode: "camera", microphone: true },
				},
			]),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
		expect(forwarded).toHaveLength(2);

		const opened = forwarded.find(
			(request) => request.body.payload.name === "app_opened",
		);
		expect(opened?.url).toBe("https://openpanel.test/track");
		expect(opened?.headers).toMatchObject({
			"openpanel-client-id": "client-id",
			"openpanel-client-secret": "client-secret",
			"openpanel-client-ip": "203.0.113.7",
			"User-Agent":
				"Cap-iOS/1.0.4 (iPhone; CPU iPhone OS 26_1 like Mac OS X; Apple)",
		});
		expect(opened?.body).toEqual({
			type: "track",
			payload: {
				name: "app_opened",
				profileId: "user_1",
				properties: {
					signed_in: true,
					platform: "ios",
					app_version: "1.0.4",
					app_build: "2026111201",
					__timestamp: "2026-11-12T09:59:48.000Z",
				},
			},
		});
		const started = forwarded.find(
			(request) => request.body.payload.name === "recording_started",
		);
		expect(started?.body.payload.properties.__timestamp).toBe(
			"2026-11-12T09:59:56.000Z",
		);
	});

	it("turns away a batch that has no signed-in session before anything is forwarded", async () => {
		mocks.signedIn = false;
		const response = await post(
			batch([{ name: "app_opened", timestamp: NOW }]),
		);
		expect(response.status).toBe(401);
		expect(mocks.rateLimitCalls).toHaveLength(0);
		expect(forwarded).toHaveLength(0);
	});

	it("takes the user from the session, never from the batch", async () => {
		await post(
			batch([
				{
					name: "cap_opened",
					timestamp: NOW,
					properties: { profileId: "someone-else", user_id: "someone-else" },
				},
			]),
		);
		expect(forwarded[0]?.body.payload.profileId).toBe("user_1");
		expect(forwarded[0]?.body.payload.properties).not.toHaveProperty(
			"profileId",
		);
	});

	it("corrects a wrong phone clock from the batch's own send time", async () => {
		const skew = 3 * 60 * 60 * 1000;
		await post(
			batch(
				[{ name: "app_opened", timestamp: NOW + skew - 30_000 }],
				NOW + skew,
			),
		);
		expect(forwarded[0]?.body.payload.properties.__timestamp).toBe(
			"2026-11-12T09:59:30.000Z",
		);
	});

	it("drops reserved and malformed property names and events older than a week", async () => {
		await post(
			batch([
				{
					name: "cap_opened",
					timestamp: NOW - 1_000,
					properties: {
						source: "library",
						__ip: "198.51.100.1",
						__identify: "someone-else",
						profileId: "someone-else",
						path: "/admin",
						referrer: "https://example.com",
					},
				},
				{ name: "app_opened", timestamp: NOW - 8 * 24 * 60 * 60 * 1000 },
			]),
		);
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0]?.body.payload).toEqual({
			name: "cap_opened",
			profileId: "user_1",
			properties: {
				source: "library",
				platform: "ios",
				app_version: "1.0.4",
				app_build: "2026111201",
				__timestamp: "2026-11-12T09:59:59.000Z",
			},
		});
	});

	it("gives screen views a path and reports tablets as tablets", async () => {
		await post({
			sentAt: NOW,
			app: { ...app, device: "tablet", os: "27.0.1" },
			events: [
				{
					name: "screen_view",
					timestamp: NOW,
					properties: { screen: "settings/profile" },
				},
				{
					name: "screen_view",
					timestamp: NOW,
					properties: { screen: "../admin" },
				},
			],
		});
		expect(forwarded[0]?.headers["User-Agent"]).toBe(
			"Cap-iOS/1.0.4 (iPad; CPU OS 27_0_1 like Mac OS X; Apple)",
		);
		const paths = forwarded.map(
			(request) => request.body.payload.properties.__path,
		);
		expect(paths.sort()).toEqual(["/settings/profile", undefined]);
	});

	it("rejects batches that are empty, too large or badly shaped", async () => {
		const event = { name: "app_opened", timestamp: NOW };
		const rejected = [
			batch([]),
			batch(Array.from({ length: 51 }, () => event)),
			batch([{ name: "App Opened", timestamp: NOW }]),
			batch([{ name: "app_opened", timestamp: "now" }]),
			batch([{ ...event, properties: { note: "x".repeat(121) } }]),
			batch([{ ...event, properties: { nested: { a: 1 } } }]),
			{ sentAt: NOW, app: { ...app, version: "1.0 (beta)" }, events: [event] },
			{
				sentAt: NOW,
				app: { ...app, os: "26.1\r\nX-Injected: 1" },
				events: [event],
			},
			{ sentAt: NOW, app: { ...app, device: "watch" }, events: [event] },
		];
		for (const body of rejected) {
			expect((await post(body)).status).toBe(400);
		}
		expect(forwarded).toHaveLength(0);
		expect(
			(await post(batch(Array.from({ length: 50 }, () => event)))).status,
		).toBe(200);
		expect(forwarded).toHaveLength(50);
	});

	it("rate limits each user before anything is forwarded", async () => {
		mocks.limited = true;
		const response = await post(
			batch([{ name: "app_opened", timestamp: NOW }]),
		);
		expect(response.status).toBe(429);
		expect(mocks.rateLimitCalls).toEqual([
			{ ruleId: "rl_mobile_events", key: "mobile-events:user_1" },
		]);
		expect(forwarded).toHaveLength(0);
	});

	it("asks the app to retry when OpenPanel took nothing, and accepts a partial delivery", async () => {
		const events = [
			{ name: "app_opened", timestamp: NOW },
			{ name: "cap_opened", timestamp: NOW },
		];
		openPanelStatus = 503;
		expect((await post(batch(events))).status).toBe(500);

		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				const { payload } = JSON.parse(init.body as string);
				if (payload.name === "cap_opened") throw new Error("socket hang up");
				return new Response(null, { status: 202 });
			}),
		);
		expect((await post(batch(events))).status).toBe(200);
	});
});
