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
	updatedAt: new Date(0),
	createNotification: vi.fn(async () => undefined),
	sendFirstViewEmail: vi.fn(async () => undefined),
	dispose: async () => {},
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/Notification", () => ({
	createNotification: mocks.createNotification,
	sendFirstViewEmail: mocks.sendFirstViewEmail,
}));

vi.mock("@/lib/server", async () => {
	const { Database, Tinybird, Videos } = await import("@cap/web-backend");
	const { HttpAuthMiddleware, Organisation, User } = await import(
		"@cap/web-domain"
	);
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Effect, Layer, Option } = await import("effect");
	const Db = await import("@cap/database/schema");
	const client = {
		select: (columns: Record<string, unknown>) => {
			let table: unknown;
			const rows = () => {
				if (table === Db.users) return [{ preferences: null }];
				if (table === Db.organizations) return [{ id: "org" }];
				if (table !== Db.videos) return [];
				if ("hasPassword" in columns) {
					return [
						{
							ownerId: "owner",
							ownerPreferences: null,
							hasPassword: false,
							hasInheritedPassword: false,
							sharedWithOrganization: true,
							sharedWithAccessibleSpace: false,
						},
					];
				}
				return [
					{
						orgId: "org",
						ownerId: "owner",
						createdAt: new Date(),
						updatedAt: mocks.updatedAt,
						firstViewEmailSentAt: new Date(),
						activeUploadVideoId: null,
					},
				];
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
	const tinybird = Layer.mock(Tinybird, {
		_tag: "Tinybird",
		enabled: false,
		appendEvents: () => Effect.void,
	});
	const videos = Layer.succeed(
		Videos,
		{} as unknown as Context.Tag.Service<typeof Videos>,
	);
	const auth = Layer.succeed(
		HttpAuthMiddleware,
		Effect.succeed({
			id: User.UserId.make("viewer"),
			email: "viewer@example.com",
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
				Layer.provideMerge(tinybird),
				Layer.provideMerge(videos),
				Layer.merge(HttpServer.layerContext),
				HttpApiBuilder.toWebHandler,
			);
			mocks.dispose = handler.dispose;
			return handler.handler;
		},
	};
});

describe("mobile Cap views", () => {
	let POST: typeof import("@/app/api/mobile/[...route]/route").POST;

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
		({ POST } = await import("@/app/api/mobile/[...route]/route"));
	});

	beforeEach(() => {
		mocks.updatedAt = new Date(Date.now() - 10 * 60 * 1000);
		mocks.createNotification.mockClear();
	});

	afterAll(() => mocks.dispose());

	const trackView = () =>
		POST(
			new Request("http://localhost/api/mobile/caps/video/views", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId: "mobile-session" }),
			}),
		);

	it("notifies the owner like a signed-in view on the share page", async () => {
		expect((await trackView()).status).toBe(200);

		await vi.waitFor(() =>
			expect(mocks.createNotification).toHaveBeenCalledWith({
				type: "view",
				videoId: "video",
				authorId: "viewer",
			}),
		);
	});

	it("does not notify for a Cap that was just updated", async () => {
		mocks.updatedAt = new Date();

		expect((await trackView()).status).toBe(200);

		expect(mocks.createNotification).not.toHaveBeenCalled();
	});
});
