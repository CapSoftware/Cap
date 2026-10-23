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

type TokenRow = { identifier: string; token: string; expires: Date };

const mocks = vi.hoisted(() => ({
	isRateLimited: vi.fn<(ruleId: string, opts?: unknown) => Promise<boolean>>(),
	sendEmail: vi.fn<(input: { react: { code: string } }) => Promise<void>>(),
	tokenRow: null as TokenRow | null,
	selectBarrier: null as null | { size: number; waiting: (() => void)[] },
	apiKeys: [] as string[],
	dispose: async () => {},
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rate-limit")>()),
	isRateLimited: mocks.isRateLimited,
}));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@cap/database/emails/otp-email", () => ({
	OTPEmail: (props: { code: string; email: string }) => props,
}));
vi.mock("@/lib/account-deletion-request", () => ({
	createAccountDeletionRequest: vi.fn(),
	createMobileContentReport: vi.fn(),
	hasPendingAccountDeletion: vi.fn(async () => false),
}));
vi.mock("@cap/database/auth/auth-options", () => ({
	authOptions: () => ({
		adapter: {
			createUser: vi.fn(async ({ email }: { email: string }) => ({
				id: "user-1",
				email,
			})),
			getUserByEmail: vi.fn(async (email: string) => ({
				id: "user-1",
				email,
			})),
			updateUser: vi.fn(async ({ id }: { id: string }) => ({ id })),
		},
	}),
}));

vi.mock("@/lib/server", async () => {
	const { Database, Videos } = await import("@cap/web-backend");
	const { HttpAuthMiddleware } = await import("@cap/web-domain");
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Effect, Layer } = await import("effect");
	const Db = await import("@cap/database/schema");

	const matches = (condition: SQL, row: TokenRow) => {
		const query = new MySqlDialect().sqlToQuery(condition);
		const columns = [
			...query.sql.matchAll(
				/`verification_tokens`\.`(identifier|token)`\s*=\s*\?/g,
			),
		].map((match) => match[1] as "identifier" | "token");
		if (columns.length === 0) {
			throw new Error(`Unexpected predicate: ${query.sql}`);
		}
		return columns.every((column, i) => row[column] === query.params[i]);
	};

	const waitAtBarrier = async () => {
		const barrier = mocks.selectBarrier;
		if (!barrier) return;
		await new Promise<void>((resolve) => {
			barrier.waiting.push(resolve);
			if (barrier.waiting.length >= barrier.size) {
				for (const release of barrier.waiting) release();
			}
		});
	};

	const client = {
		select: () => ({
			from: (table: unknown) => ({
				where: (condition: SQL) => ({
					limit: async () => {
						if (table !== Db.verificationTokens) return [];
						const row = mocks.tokenRow;
						const result = row && matches(condition, row) ? [{ ...row }] : [];
						await waitAtBarrier();
						return result;
					},
				}),
			}),
		}),
		insert: (table: unknown) => ({
			values: async (value: TokenRow & { id?: string }) => {
				if (table === Db.verificationTokens) {
					mocks.tokenRow = {
						identifier: value.identifier,
						token: value.token,
						expires: value.expires,
					};
				}
				if (table === Db.authApiKeys && value.id) mocks.apiKeys.push(value.id);
			},
		}),
		update: (table: unknown) => ({
			set: (value: Partial<TokenRow>) => ({
				where: async (condition: SQL) => {
					const row = mocks.tokenRow;
					if (
						table === Db.verificationTokens &&
						row &&
						matches(condition, row)
					) {
						mocks.tokenRow = { ...row, ...value };
					}
				},
			}),
		}),
		delete: (table: unknown) => ({
			where: async (condition: SQL) => {
				await Promise.resolve();
				if (table !== Db.verificationTokens) return [{ affectedRows: 0 }];
				const row = mocks.tokenRow;
				if (row && matches(condition, row)) {
					mocks.tokenRow = null;
					return [{ affectedRows: 1 }];
				}
				return [{ affectedRows: 0 }];
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
	const auth = Layer.succeed(HttpAuthMiddleware, Effect.die("unused"));

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

describe("mobile email sessions", () => {
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
			RESEND_API_KEY: "synthetic",
			NODE_ENV: "test",
		});
		({ POST } = await import("@/app/api/mobile/[...route]/route"));
	});

	beforeEach(() => {
		mocks.isRateLimited.mockReset().mockResolvedValue(false);
		mocks.sendEmail.mockReset().mockResolvedValue(undefined);
		mocks.tokenRow = null;
		mocks.selectBarrier = null;
		mocks.apiKeys = [];
	});

	afterAll(() => mocks.dispose());

	const post = (path: string, body: unknown) =>
		POST(
			new Request(`http://localhost/api/mobile/session/email/${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);

	const requestCode = async (email = "person@example.com") => {
		const response = await post("request", { email });
		expect(response.status).toBe(200);
		const code = mocks.sendEmail.mock.calls.at(-1)?.[0].react.code;
		if (!code) throw new Error("No code was sent");
		return code;
	};

	const wrongCode = (code: string) => (code === "123456" ? "654321" : "123456");

	it("sends a code and signs in with it", async () => {
		const code = await requestCode(" Person@Example.com ");

		const response = await post("verify", {
			email: "person@example.com",
			code,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			type: "api_key",
			userId: "user-1",
		});
		expect(mocks.tokenRow).toBeNull();
		expect(mocks.isRateLimited.mock.calls.map(([ruleId]) => ruleId)).toEqual([
			"rl_auth_otp_send",
			"rl_auth_otp_verify",
		]);
	});

	it("uses one bucket per normalized email", async () => {
		await requestCode(" Person@Example.com ");
		await requestCode("person@example.com");

		const [first, second] = mocks.isRateLimited.mock.calls.map(
			([, opts]) => (opts as { key: string }).key,
		);
		expect(first).toMatch(/^email-code-send:[0-9a-f]{64}$/);
		expect(second).toBe(first);
	});

	it("returns 429 without sending when code requests are limited", async () => {
		mocks.isRateLimited.mockResolvedValue(true);

		const response = await post("request", { email: "person@example.com" });

		expect(response.status).toBe(429);
		expect(mocks.sendEmail).not.toHaveBeenCalled();
		expect(mocks.tokenRow).toBeNull();
	});

	it("returns 429 and keeps the code when verification is limited", async () => {
		const code = await requestCode();
		mocks.isRateLimited.mockResolvedValue(true);

		const response = await post("verify", {
			email: "person@example.com",
			code,
		});

		expect(response.status).toBe(429);
		expect(mocks.tokenRow).not.toBeNull();
		expect(mocks.apiKeys).toEqual([]);
	});

	it("invalidates the code after a wrong attempt", async () => {
		const code = await requestCode();

		const wrong = await post("verify", {
			email: "person@example.com",
			code: wrongCode(code),
		});
		const retry = await post("verify", {
			email: "person@example.com",
			code,
		});

		expect(wrong.status).toBe(403);
		expect(retry.status).toBe(403);
		expect(mocks.apiKeys).toEqual([]);
	});

	it("rejects an expired code", async () => {
		const code = await requestCode();
		if (!mocks.tokenRow) throw new Error("No stored code");
		mocks.tokenRow.expires = new Date(Date.now() - 1000);

		const response = await post("verify", {
			email: "person@example.com",
			code,
		});

		expect(response.status).toBe(403);
		expect(mocks.tokenRow).toBeNull();
	});

	it("lets only one of two concurrent verifications use a code", async () => {
		const code = await requestCode();
		mocks.selectBarrier = { size: 2, waiting: [] };

		const responses = await Promise.all([
			post("verify", { email: "person@example.com", code }),
			post("verify", { email: "person@example.com", code }),
		]);

		expect(responses.map((response) => response.status).sort()).toEqual([
			200, 403,
		]);
		expect(mocks.apiKeys).toHaveLength(1);
	});
});
