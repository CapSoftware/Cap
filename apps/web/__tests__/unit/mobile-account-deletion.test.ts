import type { DbClient } from "@cap/web-backend/src/Database";
import type { HttpApi } from "@effect/platform";
import type { SQL, Table } from "drizzle-orm";
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
	createAccountDeletionRequest: vi.fn(),
	updates: [] as {
		table: string;
		value: unknown;
		where: { sql: string; params: unknown[] };
	}[],
	deletes: [] as string[],
	dispose: async () => {},
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/account-deletion-request", () => ({
	createAccountDeletionRequest: mocks.createAccountDeletionRequest,
	createMobileContentReport: vi.fn(),
	hasPendingAccountDeletion: vi.fn(async () => false),
}));

vi.mock("@/lib/server", async () => {
	const { Database, Videos } = await import("@cap/web-backend");
	const { HttpAuthMiddleware, Organisation, User } = await import(
		"@cap/web-domain"
	);
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Effect, Layer, Option } = await import("effect");
	const { getTableName } = await import("drizzle-orm");
	const { MySqlDialect } = await import("drizzle-orm/mysql-core");
	const dialect = new MySqlDialect();

	const client = {
		update: (table: Table) => ({
			set: (value: unknown) => ({
				where: async (condition: SQL) => {
					const { sql, params } = dialect.sqlToQuery(condition);
					mocks.updates.push({
						table: getTableName(table),
						value,
						where: { sql, params },
					});
				},
			}),
		}),
		delete: (table: Table) => ({
			where: async () => {
				mocks.deletes.push(getTableName(table));
			},
		}),
	};
	const clientWithTransaction = {
		...client,
		transaction: async (callback: (tx: typeof client) => Promise<unknown>) =>
			callback(client),
	};
	const database = Layer.succeed(
		Database,
		Database.make({
			use: (callback) =>
				Effect.promise(() =>
					callback(clientWithTransaction as unknown as DbClient),
				),
		}),
	);
	const videos = Layer.succeed(
		Videos,
		{} as unknown as Context.Tag.Service<typeof Videos>,
	);
	const auth = Layer.succeed(
		HttpAuthMiddleware,
		Effect.succeed({
			id: User.UserId.make("user-1"),
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

describe("mobile account deletion request", () => {
	let POST: typeof import("@/app/api/mobile/[...route]/route").POST;

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
		({ POST } = await import("@/app/api/mobile/[...route]/route"));
	});

	beforeEach(() => {
		mocks.updates = [];
		mocks.deletes = [];
		mocks.createAccountDeletionRequest.mockResolvedValue({
			id: "request-1",
			status: "created",
			notificationSent: true,
		});
	});

	afterAll(() => mocks.dispose());

	const request = () =>
		POST(
			new Request("http://localhost/api/mobile/user/account-deletion", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmation: "DELETE" }),
			}),
		);

	it("signs the account out of every session, app key and agent key", async () => {
		expect((await request()).status).toBe(200);

		expect(mocks.deletes).toEqual(["sessions", "auth_api_keys"]);
		expect(mocks.updates.map(({ table }) => table)).toEqual([
			"users",
			"agent_api_keys",
		]);
		expect(mocks.updates[1]).toEqual({
			table: "agent_api_keys",
			value: { revokedAt: expect.any(Date) },
			where: {
				sql: "(`agent_api_keys`.`userId` = ? and `agent_api_keys`.`revokedAt` is null)",
				params: ["user-1"],
			},
		});
	});

	it("leaves every credential in place when the request cannot be recorded", async () => {
		mocks.createAccountDeletionRequest.mockRejectedValueOnce(
			new Error("database unavailable"),
		);

		expect((await request()).status).toBe(500);
		expect(mocks.deletes).toEqual([]);
		expect(mocks.updates).toEqual([]);
	});
});
