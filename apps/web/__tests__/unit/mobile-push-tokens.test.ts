import { createHash } from "node:crypto";
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
	inserts: [] as { values: Record<string, unknown>; onDuplicate: unknown }[],
	deletes: [] as unknown[],
	stale: [] as { id: string }[],
	tokenTableMissing: false,
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
				orderBy: () => query,
				limit: () => query,
				offset: async () => mocks.stale,
			};
			return query;
		},
		insert: () => ({
			values: (values: Record<string, unknown>) => ({
				onDuplicateKeyUpdate: async (onDuplicate: unknown) => {
					mocks.inserts.push({ values, onDuplicate });
				},
			}),
		}),
		delete: () => ({
			where: async (condition: unknown) => {
				mocks.deletes.push(condition);
				if (
					mocks.tokenTableMissing &&
					new MySqlDialect()
						.sqlToQuery(condition as SQL)
						.sql.includes("mobile_push_tokens")
				) {
					throw new Error("Table 'mobile_push_tokens' doesn't exist");
				}
			},
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

describe("mobile push tokens", () => {
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
		mocks.inserts = [];
		mocks.deletes = [];
		mocks.stale = [];
		mocks.tokenTableMissing = false;
	});

	afterAll(() => mocks.dispose());

	const apiKey = "0f3a5c2e-6b4d-4a7f-9e1c-2d3b4a5c6d7e";
	const sessionHash = createHash("sha256").update(apiKey).digest("hex");
	const post = (path: string, body: unknown, authorized = true) =>
		route.POST(
			new Request(`http://localhost/api/mobile/${path}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(authorized ? { Authorization: `Bearer ${apiKey}` } : {}),
				},
				body: JSON.stringify(body),
			}),
		);
	const query = (value: unknown) => new MySqlDialect().sqlToQuery(value as SQL);
	const token = "AB".repeat(32);

	it("registers a token for the signed-in user and moves it on re-register", async () => {
		const response = await post("user/push-tokens", {
			token,
			environment: "sandbox",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
		expect(mocks.inserts).toHaveLength(1);
		expect(mocks.inserts[0]?.values).toMatchObject({
			userId: "user",
			token: token.toLowerCase(),
			sessionHash,
			environment: "sandbox",
		});
		expect(mocks.inserts[0]?.onDuplicate).toEqual({
			set: { userId: "user", sessionHash, environment: "sandbox" },
		});
		expect(mocks.deletes).toHaveLength(0);
	});

	it("needs the session's bearer token to register", async () => {
		expect(
			(await post("user/push-tokens", { token, environment: "sandbox" }, false))
				.status,
		).toBe(400);
		expect(mocks.inserts).toHaveLength(0);
	});

	it("keeps only the user's 10 newest tokens", async () => {
		mocks.stale = [{ id: "old1" }, { id: "old2" }];
		expect(
			(await post("user/push-tokens", { token, environment: "production" }))
				.status,
		).toBe(200);
		expect(mocks.deletes).toHaveLength(1);
		const { sql, params } = query(mocks.deletes[0]);
		expect(sql).toContain("`mobile_push_tokens`.`id` in (?, ?)");
		expect(params).toEqual(["old1", "old2"]);
	});

	it("revokes the key, then drops the session's push tokens", async () => {
		expect((await post("session/revoke", {})).status).toBe(200);
		const [apiKeys, pushTokens] = mocks.deletes.map((condition) =>
			query(condition),
		);
		expect(apiKeys?.sql).toContain("`auth_api_keys`.`id` = ?");
		expect(pushTokens?.sql).toContain("`mobile_push_tokens`.`sessionHash` = ?");
		expect(pushTokens?.params).toEqual([sessionHash]);
	});

	it("still revokes the key when the push token table isn't there yet", async () => {
		mocks.tokenTableMissing = true;
		expect((await post("session/revoke", {})).status).toBe(200);
		expect(query(mocks.deletes[0]).sql).toContain("`auth_api_keys`.`id` = ?");
	});

	it("rejects tokens that aren't hex and unknown environments", async () => {
		expect(
			(
				await post("user/push-tokens", {
					token: "not-a-token",
					environment: "sandbox",
				})
			).status,
		).toBe(400);
		expect(
			(await post("user/push-tokens", { token, environment: "staging" }))
				.status,
		).toBe(400);
		expect(mocks.inserts).toHaveLength(0);
	});

	it("removes only the caller's own token", async () => {
		expect((await post("user/push-tokens/remove", { token })).status).toBe(200);
		expect(mocks.deletes).toHaveLength(1);
		const { sql, params } = query(mocks.deletes[0]);
		expect(sql).toContain("`mobile_push_tokens`.`token` = ?");
		expect(sql).toContain("`mobile_push_tokens`.`userId` = ?");
		expect(params).toEqual([token.toLowerCase(), "user"]);
	});
});
