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
	ownerId: "owner",
	revalidatePath: vi.fn(),
	update: vi.fn(),
	dispose: async () => {},
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/server", async () => {
	const { Database, Videos } = await import("@cap/web-backend");
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
		public: true,
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
					return [{ ...summary, ownerId: mocks.ownerId }];
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
				where: async () => {
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

describe("mobile Cap password update", () => {
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
	});

	afterAll(() => mocks.dispose());

	const request = () =>
		PATCH(
			new Request("http://localhost/api/mobile/caps/video/password", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password: null }),
			}),
		);

	it("revalidates the share page after removing its password", async () => {
		expect((await request()).status).toBe(200);
		expect(mocks.update).toHaveBeenCalledWith({ password: null });
		expect(mocks.revalidatePath.mock.calls.map(([path]) => path)).toEqual([
			"/dashboard/caps",
			"/dashboard/shared-caps",
			"/s/video",
		]);
	});

	it("does not revalidate when the caller does not own the Cap", async () => {
		mocks.ownerId = "someone-else";
		expect((await request()).status).toBe(404);
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});
});
