import type { DbClient } from "@cap/web-backend/src/Database";
import type { HttpApi } from "@effect/platform";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm/sql";
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
	preferences: null as unknown,
	updates: [] as { preferences: unknown }[],
	dispose: async () => {},
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/server", async () => {
	const { Database, Videos, VideosPolicy } = await import("@cap/web-backend");
	const { HttpAuthMiddleware, Organisation, User } = await import(
		"@cap/web-domain"
	);
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Effect, Layer, Option } = await import("effect");
	const client = {
		select: () => {
			const query = {
				from: () => query,
				where: () => query,
				limit: async () => [{ preferences: mocks.preferences }],
			};
			return query;
		},
		update: () => ({
			set: (value: { preferences: unknown }) => ({
				where: async () => {
					mocks.updates.push(value);
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
		Effect.succeed({
			id: User.UserId.make("user"),
			email: "user@example.com",
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

describe("mobile notification preferences", () => {
	let route: typeof import("@/app/api/mobile/[...route]/route");

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
		route = await import("@/app/api/mobile/[...route]/route");
	});

	beforeEach(() => {
		mocks.preferences = null;
		mocks.updates = [];
	});

	afterAll(() => mocks.dispose());

	const url = "http://localhost/api/mobile/user/notification-preferences";
	const patch = (body: unknown) =>
		route.PATCH(
			new Request(url, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
	const params = (value: unknown) =>
		new MySqlDialect()
			.sqlToQuery(value as SQL)
			.params.map((param) => JSON.parse(String(param)));

	it("turns everything on for a user who never changed a setting", async () => {
		const response = await route.GET(new Request(url));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			comments: true,
			replies: true,
			views: true,
			anonymousViews: true,
			reactions: true,
		});
	});

	it("reads the web's pause flags", async () => {
		mocks.preferences = {
			notifications: {
				pauseComments: true,
				pauseReplies: false,
				pauseViews: false,
				pauseReactions: true,
				pauseAnonViews: true,
			},
		};
		const response = await route.GET(new Request(url));
		expect(await response.json()).toEqual({
			comments: false,
			replies: true,
			views: true,
			anonymousViews: false,
			reactions: false,
		});
	});

	it("writes only the changed flag, over defaults for the rest", async () => {
		expect((await patch({ views: false })).status).toBe(200);
		expect(mocks.updates).toHaveLength(1);
		expect(params(mocks.updates[0]?.preferences)).toEqual([
			{
				pauseComments: false,
				pauseReplies: false,
				pauseViews: false,
				pauseAnonViews: false,
				pauseReactions: false,
			},
			{ pauseViews: true },
		]);
	});

	it("skips the write when nothing changes", async () => {
		expect((await patch({})).status).toBe(200);
		expect(mocks.updates).toHaveLength(0);
	});

	it("rejects values that aren't booleans", async () => {
		expect((await patch({ views: "off" })).status).toBe(400);
		expect(mocks.updates).toHaveLength(0);
	});
});
