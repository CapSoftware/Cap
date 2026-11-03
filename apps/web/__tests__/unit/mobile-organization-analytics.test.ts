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
	isMember: true,
	subscriptionStatus: "active" as string | null,
	canViewSpace: true,
	getOrgAnalyticsData: vi.fn(),
	canViewSpaceAnalytics: vi.fn(),
	dispose: async () => {},
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/(org)/dashboard/analytics/data", () => ({
	getOrgAnalyticsData: mocks.getOrgAnalyticsData,
}));
vi.mock("@/lib/space-analytics-access", () => ({
	canViewSpaceAnalytics: mocks.canViewSpaceAnalytics,
}));

vi.mock("@/lib/server", async () => {
	const { Database, Videos } = await import("@cap/web-backend");
	const { HttpAuthMiddleware, Organisation, User } = await import(
		"@cap/web-domain"
	);
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Effect, Layer, Option } = await import("effect");
	const Db = await import("@cap/database/schema");
	const { sql } = await import("drizzle-orm");
	const client = {
		select: () => {
			let table: unknown;
			const rows = () => {
				if (table === Db.organizations) {
					return mocks.isMember ? [{ id: "org" }] : [];
				}
				if (table === Db.videos) {
					return [{ name: "Demo video", orgId: "org" }];
				}
				if (table === Db.users) {
					return [
						{
							stripeSubscriptionStatus: mocks.subscriptionStatus,
							thirdPartyStripeSubscriptionId: null,
							preferences: null,
						},
					];
				}
				return [];
			};
			const query = {
				from: (value: unknown) => {
					table = value;
					return query;
				},
				leftJoin: () => query,
				innerJoin: () => query,
				where: () => query,
				limit: async () => rows(),
				getSQL: () => sql`SELECT 1`,
			};
			return query;
		},
	};
	const database = Layer.succeed(
		Database,
		Database.make({
			use: (callback) =>
				Effect.promise(() => callback(client as unknown as DbClient)),
		}),
	);
	const videos = Layer.succeed(
		Videos,
		{} as unknown as Context.Tag.Service<typeof Videos>,
	);
	const auth = Layer.succeed(
		HttpAuthMiddleware,
		Effect.succeed({
			id: User.UserId.make("member"),
			email: "member@example.com",
			activeOrganizationId: Organisation.OrganisationId.make("org"),
			iconUrlOrKey: Option.none(),
		}),
	);
	return {
		apiToHandler: (
			api: EffectLayer.Layer<
				HttpApi.Api,
				never,
				| Context.Tag.Identifier<typeof Database>
				| Context.Tag.Identifier<typeof Videos>
				| Context.Tag.Identifier<typeof HttpAuthMiddleware>
			>,
		) => {
			const handler = api.pipe(
				Layer.provideMerge(auth),
				Layer.provideMerge(database),
				Layer.provideMerge(videos),
				Layer.merge(HttpServer.layerContext),
				HttpApiBuilder.toWebHandler,
			);
			mocks.dispose = handler.dispose;
			return handler.handler;
		},
	};
});

const analytics = {
	counts: { caps: 2, views: 300, comments: 4, reactions: 6 },
	chart: Array.from({ length: 200 }, (_, index) => ({
		bucket: `2026-10-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`,
		caps: 0,
		views: 1,
		comments: 0,
		reactions: 0,
	})),
	breakdowns: {
		countries: [{ name: "GB", views: 300, percentage: 100 }],
		cities: [],
		browsers: [],
		operatingSystems: [],
		devices: [],
		topCaps: [{ id: "video", name: "Demo", views: 300, percentage: 100 }],
	},
};

describe("mobile organization analytics", () => {
	let GET: typeof import("@/app/api/mobile/[...route]/route").GET;

	beforeAll(async () => {
		Object.assign(process.env, {
			NEXT_PUBLIC_IS_CAP: "true",
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
		});
		({ GET } = await import("@/app/api/mobile/[...route]/route"));
	});

	beforeEach(() => {
		mocks.isMember = true;
		mocks.subscriptionStatus = "active";
		mocks.getOrgAnalyticsData.mockReset();
		mocks.getOrgAnalyticsData.mockResolvedValue(analytics);
		mocks.canViewSpaceAnalytics.mockReset();
		mocks.canViewSpaceAnalytics.mockImplementation(
			async () => mocks.canViewSpace,
		);
		mocks.canViewSpace = true;
	});

	afterAll(() => mocks.dispose());

	const request = (query = "") =>
		GET(new Request(`http://localhost/api/mobile/analytics${query}`));

	it("returns downsampled analytics for the active organization", async () => {
		const response = await request("?range=30d");
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.available).toBe(true);
		expect(body.data.counts.views).toBe(300);
		expect(body.data.capName).toBe("");
		expect(body.data.chart.length).toBeLessThanOrEqual(96);
		expect(
			body.data.chart.reduce(
				(total: number, point: { views: number }) => total + point.views,
				0,
			),
		).toBe(200);
		expect(mocks.getOrgAnalyticsData).toHaveBeenCalledWith(
			"org",
			"30d",
			undefined,
		);
		expect(mocks.canViewSpaceAnalytics).not.toHaveBeenCalled();
	});

	it("defaults to the seven day range", async () => {
		expect((await request()).status).toBe(200);
		expect(mocks.getOrgAnalyticsData).toHaveBeenCalledWith(
			"org",
			"7d",
			undefined,
		);
	});

	it("reports analytics as unavailable without Pro", async () => {
		mocks.subscriptionStatus = null;
		const response = await request();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ available: false, data: null });
		expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
	});

	it("rejects callers outside the organization", async () => {
		mocks.isMember = false;
		expect((await request()).status).toBe(403);
		expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
	});

	it("checks space access before loading space analytics", async () => {
		expect((await request("?spaceId=space_1")).status).toBe(200);
		expect(mocks.canViewSpaceAnalytics).toHaveBeenCalledWith(
			"member",
			"org",
			"space_1",
		);
		expect(mocks.getOrgAnalyticsData).toHaveBeenCalledWith(
			"org",
			"7d",
			"space_1",
		);

		mocks.getOrgAnalyticsData.mockClear();
		mocks.canViewSpace = false;
		expect((await request("?spaceId=space_2")).status).toBe(403);
		expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
	});

	it("keeps per-Cap analytics on the shared helpers", async () => {
		const response = await GET(
			new Request("http://localhost/api/mobile/caps/video/analytics?range=24h"),
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.available).toBe(true);
		expect(body.data.capName).toBe("Demo video");
		expect(body.data.chart.length).toBeLessThanOrEqual(96);
		expect(body.data.breakdowns.topCaps[0].id).toBe("video");
		expect(mocks.getOrgAnalyticsData).toHaveBeenCalledWith(
			"org",
			"24h",
			undefined,
			"video",
		);

		mocks.getOrgAnalyticsData.mockClear();
		mocks.subscriptionStatus = null;
		const gated = await GET(
			new Request("http://localhost/api/mobile/caps/video/analytics"),
		);
		expect(await gated.json()).toEqual({ available: false, data: null });
		expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
	});

	it("rejects unknown ranges", async () => {
		expect((await request("?range=forever")).status).toBe(400);
		expect(mocks.getOrgAnalyticsData).not.toHaveBeenCalled();
	});
});
