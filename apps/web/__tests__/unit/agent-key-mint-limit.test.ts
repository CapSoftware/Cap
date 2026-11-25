import { createHash } from "node:crypto";
import { Database } from "@cap/web-backend";
import { DatabaseError } from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	keysToday: 0,
	countedSince: null as string | null,
	countLock: null as string | null,
	consumed: 0,
	minted: 0,
}));

const dialect = new MySqlDialect();

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ CAP_BLOCKED_SIGNUP_DOMAINS: "" }),
	buildEnv: {},
}));

const grant = {
	id: "grant-1",
	userId: "user-1",
	redirectUri: "http://127.0.0.1:49152/callback",
	codeChallenge: createHash("sha256")
		.update("v".repeat(43))
		.digest("base64url"),
	consumedAt: null,
	expiresAt: new Date(Date.now() + 60_000),
	scopes: ["caps:read"],
};

const tx = {
	select: (fields?: Record<string, unknown>) => ({
		from: () => ({
			where: (condition: SQL) => {
				if (fields && "total" in fields) {
					state.countedSince = String(dialect.sqlToQuery(condition).params[1]);
					return {
						for: async (strength: string) => {
							state.countLock = strength;
							return [{ total: state.keysToday }];
						},
					};
				}
				return {
					limit: () =>
						Object.assign(Promise.resolve([grant]), {
							for: async () => [{ id: "user-1", email: "me@open.example" }],
						}),
				};
			},
		}),
	}),
	update: () => ({
		set: () => ({
			where: async () => {
				state.consumed += 1;
				return [{ affectedRows: 1 }];
			},
		}),
	}),
	insert: () => ({
		values: async () => {
			state.minted += 1;
		},
	}),
};

const database = Layer.succeed(
	Database,
	Database.make({
		use: (callback) =>
			Effect.tryPromise({
				try: () =>
					callback({
						transaction: (run: (t: typeof tx) => unknown) => run(tx),
					} as never),
				catch: (cause) => new DatabaseError({ cause }),
			}),
	}),
);

const { exchangeAgentAuthorizationCode } = await import("@/lib/agent-token");

const exchange = () =>
	Effect.runPromiseExit(
		exchangeAgentAuthorizationCode(
			{
				code: "c".repeat(43),
				codeVerifier: "v".repeat(43),
				redirectUri: "http://127.0.0.1:49152/callback",
			},
			"request-1",
		).pipe(Effect.provide(database)),
	);

beforeEach(() => {
	state.keysToday = 0;
	state.countedSince = null;
	state.countLock = null;
	state.consumed = 0;
	state.minted = 0;
});

describe("CLI sign-in keys per account", () => {
	it("issues a key while the account made fewer than 20 in the last day", async () => {
		state.keysToday = 19;
		const before = Date.now();

		expect(Exit.isSuccess(await exchange())).toBe(true);
		expect(state.minted).toBe(1);
		expect(state.countLock).toBe("update");
		const since = Date.parse(`${state.countedSince?.replace(" ", "T")}Z`);
		expect(before - since).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
		expect(before - since).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
	});

	it("refuses with a retryable rate limit at 20, leaving the code unused", async () => {
		state.keysToday = 20;

		const exit = await exchange();

		expect(Exit.isFailure(exit)).toBe(true);
		const failure = Exit.isFailure(exit)
			? Cause.failureOption(exit.cause)
			: Option.none();
		expect(Option.getOrUndefined(failure)).toMatchObject({
			_tag: "AgentRateLimitedError",
			code: "RATE_LIMITED",
			retryable: true,
		});
		expect(state.consumed).toBe(0);
		expect(state.minted).toBe(0);
	});
});
