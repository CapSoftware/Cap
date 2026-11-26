import type { DbClient } from "@cap/web-backend/src/Database";
import type { HttpApi } from "@effect/platform";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
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
	ownerId: "owner",
	isPublic: true,
	linkState: {
		videoSettings: null as { linkAccess?: string } | null,
		organizationSettings: null as { allowPublicLinkOverride?: boolean } | null,
		allowedEmailDomain: null as string | null,
	},
	revalidatePath: vi.fn(),
	update: vi.fn(),
	where: vi.fn(),
	dispose: async () => {},
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/server", async () => {
	const { Database, Videos, VideosPolicy } = await import("@cap/web-backend");
	const { HttpAuthMiddleware, Organisation, User } = await import(
		"@cap/web-domain"
	);
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Effect, Layer, Option } = await import("effect");
	const Db = await import("@cap/database/schema");
	const { sql } = await import("drizzle-orm");
	const summary = {
		id: "video",
		ownerId: "owner",
		name: "Test video",
		createdAt: new Date("2026-01-01"),
		updatedAt: new Date("2026-01-01"),
		ownerName: "Owner",
		duration: 10,
		folderId: null,
		hasPassword: false,
		commentCount: 0,
		reactionCount: 0,
		uploadVideoId: null,
		uploadUploaded: null,
		uploadTotal: null,
		uploadPhase: null,
		processingProgress: null,
		processingMessage: null,
		processingError: null,
		metadata: null,
		transcriptionStatus: null,
	};
	const client = {
		select: (fields: Record<string, unknown>) => {
			let table: unknown;
			const rows = () => {
				if (table === Db.organizations) return [{ id: "org" }];
				if (table === Db.users) return [{ preferences: null }];
				if (table === Db.videos && "organizationSettings" in fields) {
					return [mocks.linkState];
				}
				if (table === Db.videos && "ownerPreferences" in fields) {
					return [
						{
							ownerId: mocks.ownerId,
							ownerPreferences: null,
							hasPassword: false,
							hasInheritedPassword: false,
						},
					];
				}
				if (table === Db.videos)
					return [
						{ ...summary, public: mocks.isPublic, ownerId: mocks.ownerId },
					];
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
				groupBy: async () => rows(),
				getSQL: () => sql`SELECT 1`,
			};
			return query;
		},
		update: () => ({
			set: (value: unknown) => ({
				where: async (condition: unknown) => {
					mocks.where(condition);
					mocks.update(value);
				},
			}),
		}),
	};
	const database = Layer.succeed(
		Database,
		Database.make({
			use: (callback) =>
				Effect.promise(() => callback(client as unknown as DbClient)),
		}),
	);
	const videos = Layer.succeed(Videos, {
		getAnalytics: () => Effect.succeed({ count: 0 }),
	} as unknown as Context.Tag.Service<typeof Videos>);
	const policy = Layer.succeed(VideosPolicy, {
		canView: () => Effect.void,
	} as unknown as Context.Tag.Service<typeof VideosPolicy>);
	const auth = Layer.succeed(
		HttpAuthMiddleware,
		Effect.succeed({
			id: User.UserId.make("owner"),
			email: "owner@example.com",
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

describe("mobile Cap link access", () => {
	let PATCH: typeof import("@/app/api/mobile/[...route]/route").PATCH;

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
		});
		({ PATCH } = await import("@/app/api/mobile/[...route]/route"));
	});

	beforeEach(() => {
		mocks.ownerId = "owner";
		mocks.isPublic = true;
		mocks.update.mockClear();
		mocks.where.mockClear();
		mocks.linkState = {
			videoSettings: null,
			organizationSettings: { allowPublicLinkOverride: true },
			allowedEmailDomain: "company.com",
		};
	});

	afterAll(() => mocks.dispose());

	const share = (body: Record<string, unknown>) =>
		PATCH(
			new Request("http://localhost/api/mobile/caps/video/sharing", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);

	const settingsParams = () =>
		new MySqlDialect().sqlToQuery(
			(mocks.update.mock.calls[0]?.[0] as { settings: SQL }).settings,
		).params;

	it("opens one link to anyone when the organization allows it", async () => {
		const response = await share({ public: true, linkAccess: "anyone" });
		expect(response.status).toBe(200);
		expect(mocks.update.mock.calls[0]?.[0]).toMatchObject({ public: true });
		expect(settingsParams()).toEqual(['{"linkAccess":"anyone"}']);
	});

	it.each([null, {}, { allowPublicLinkOverride: false }])(
		"refuses before writing when the organization has %j",
		async (settings) => {
			mocks.linkState.organizationSettings = settings;
			expect((await share({ public: true, linkAccess: "anyone" })).status).toBe(
				403,
			);
			expect(mocks.update).not.toHaveBeenCalled();
		},
	);

	it("restores the restriction", async () => {
		expect(
			(await share({ public: true, linkAccess: "restricted" })).status,
		).toBe(200);
		expect(settingsParams()).toEqual(['{"linkAccess":null}']);
	});

	it("clears the choice when the link is turned off", async () => {
		expect((await share({ public: false })).status).toBe(200);
		expect(mocks.update.mock.calls[0]?.[0]).toMatchObject({ public: false });
		expect(settingsParams()).toEqual(['{"linkAccess":null}']);
	});

	it("leaves settings alone for an app that sends no link access", async () => {
		expect((await share({ public: true })).status).toBe(200);
		expect(mocks.update).toHaveBeenCalledWith({ public: true });
	});

	const whereSql = () =>
		new MySqlDialect().sqlToQuery(mocks.where.mock.calls[0]?.[0] as SQL).sql;

	it.each(["anyone", "restricted"])(
		"only applies %j to a Cap that is still public",
		async (linkAccess) => {
			expect((await share({ public: true, linkAccess })).status).toBe(200);
			expect(whereSql()).toContain("`videos`.`public` = ?");
		},
	);

	it("lets a plain visibility change reach a private Cap", async () => {
		expect((await share({ public: true })).status).toBe(200);
		expect(whereSql()).not.toContain("`videos`.`public`");
	});

	it.each(["anyone", "restricted"])(
		"refuses %j on a Cap that is no longer public instead of reporting success",
		async (linkAccess) => {
			mocks.isPublic = false;
			expect((await share({ public: true, linkAccess })).status).toBe(409);
		},
	);

	it("still makes a private Cap public without a link access choice", async () => {
		mocks.isPublic = false;
		expect((await share({ public: false })).status).toBe(200);
	});

	it("rejects an unknown link access value", async () => {
		expect((await share({ public: true, linkAccess: "open" })).status).toBe(
			400,
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("does not write for a Cap the caller does not own", async () => {
		mocks.ownerId = "someone-else";
		expect((await share({ public: true, linkAccess: "anyone" })).status).toBe(
			404,
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it.each([
		[{ linkAccess: "anyone" }, "company.com", true, "anyone", false],
		[null, "company.com", true, "restricted", true],
		[{ linkAccess: "anyone" }, "company.com", false, undefined, true],
		[{ linkAccess: "anyone" }, null, true, undefined, false],
		[{ linkAccess: "anyone" }, "  ", true, undefined, false],
	])(
		"reports video %j, restriction %j, allowed %j as %j, restricted %j",
		async (
			videoSettings,
			allowedEmailDomain,
			allowed,
			expected,
			restricted,
		) => {
			mocks.linkState = {
				videoSettings,
				organizationSettings: { allowPublicLinkOverride: allowed },
				allowedEmailDomain,
			};
			const response = await share({ public: true });
			expect(response.status).toBe(200);
			const cap = await response.json();
			expect(cap.linkAccess).toBe(expected);
			expect(cap.linkRestricted).toBe(restricted);
		},
	);
});
