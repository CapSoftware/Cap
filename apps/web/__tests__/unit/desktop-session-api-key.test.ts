import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type KeyRow = {
	id: string;
	userId: string;
	source: string;
	createdAt: Date;
};

const state = vi.hoisted(() => ({
	rows: [] as KeyRow[],
	clock: 0,
	base: 0,
	userId: "user-1",
	events: [] as string[],
	mints: new Map<string, number>(),
	limiterCalls: [] as [string, string | undefined][],
}));

const dialect = new MySqlDialect();
const params = (condition: SQL) => dialect.sqlToQuery(condition).params;
const sortsNewestFirst = (ordering: SQL) =>
	/`createdAt` desc$/.test(dialect.sqlToQuery(ordering).sql);

function countRecent(condition: SQL) {
	const [userId, source, sinceParam] = params(condition);
	if (typeof sinceParam !== "string" || !/^\d{4}-\d{2}-\d{2} /.test(sinceParam))
		return [];
	const since = new Date(`${sinceParam.replace(" ", "T")}Z`);
	state.events.push("count");
	return [
		{
			total: state.rows.filter(
				(row) =>
					row.userId === userId &&
					row.source === source &&
					row.createdAt > since,
			).length,
		},
	];
}

function keysTable() {
	const insert = () => ({
		values: async (value: Omit<KeyRow, "createdAt">) => {
			state.events.push("insert");
			state.clock += 1;
			state.rows.push({
				...value,
				createdAt: new Date(state.base + state.clock),
			});
		},
	});
	const select = () => ({
		from: () => ({
			where: (condition: SQL) =>
				Object.assign(
					Promise.resolve().then(() => countRecent(condition)),
					{
						for: async (strength: string) => {
							state.events.push(
								`lock:${strength}:${params(condition).join(",")}`,
							);
							return [{ id: params(condition)[0] }];
						},
						orderBy: (ordering: SQL) => ({
							limit: (limit: number) => ({
								offset: async (offset: number) => {
									const [userId, source, excludedId] = params(condition);
									const direction = sortsNewestFirst(ordering) ? -1 : 1;
									return state.rows
										.filter(
											(row) =>
												row.userId === userId &&
												row.source === source &&
												row.id !== excludedId,
										)
										.sort(
											(a, b) =>
												direction *
												(a.createdAt.getTime() - b.createdAt.getTime()),
										)
										.slice(offset, offset + limit)
										.map((row) => ({ id: row.id }));
								},
							}),
						}),
					},
				),
		}),
	});
	const remove = () => ({
		where: async (condition: SQL) => {
			const ids = new Set(params(condition));
			state.rows = state.rows.filter((row) => !ids.has(row.id));
		},
	});
	return { insert, select, delete: remove };
}

vi.mock("@cap/database", () => ({
	db: () => {
		const table = keysTable();
		return {
			...table,
			transaction: async (callback: (tx: typeof table) => Promise<unknown>) =>
				callback(table),
		};
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: state.userId }),
}));
vi.mock("@cap/database/auth/auth-options", () => ({
	decodeSessionToken: vi.fn(),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rate-limit")>()),
	isRateLimited: async (ruleId: string, opts?: { key?: string }) => {
		state.limiterCalls.push([ruleId, opts?.key]);
		const key = opts?.key ?? "";
		const seen = (state.mints.get(key) ?? 0) + 1;
		state.mints.set(key, seen);
		return seen > 20;
	},
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		NEXTAUTH_SECRET: "secret",
		WEB_URL: "https://cap.example",
	}),
}));

const requestApiKey = async () => {
	const { app } = await import("@/app/api/desktop/[...route]/session");
	const response = await app.request(
		"https://cap.example/request?type=api_key&platform=web&port=49152",
	);
	const location = response.headers.get("location");
	if (!location) throw new Error("expected a loopback redirect");
	return new URL(location).searchParams.get("api_key");
};

const desktopKeys = (userId: string) =>
	state.rows.filter((row) => row.userId === userId && row.source === "desktop");

describe("desktop api key sign-in", () => {
	beforeEach(() => {
		state.rows = [];
		state.clock = 0;
		state.base = Date.now();
		state.userId = "user-1";
		state.events = [];
		state.mints.clear();
		state.limiterCalls = [];
	});

	it("returns a new key that stays stored for the signed-in user", async () => {
		const apiKey = await requestApiKey();

		expect(apiKey).toMatch(/^[0-9a-f-]{36}$/);
		expect(desktopKeys("user-1").map((row) => row.id)).toEqual([apiKey]);
	});

	it("keeps existing desktop keys when a user signs in on another device", async () => {
		const first = await requestApiKey();
		const second = await requestApiKey();

		expect(desktopKeys("user-1").map((row) => row.id)).toEqual([first, second]);
	});

	it("keeps only the 20 newest desktop keys per user", async () => {
		const twoHoursAgo = state.base - 2 * 60 * 60 * 1000;
		state.rows.push(
			...Array.from({ length: 20 }, (_, index) => ({
				id: `old-${index}`,
				userId: "user-1",
				source: "desktop",
				createdAt: new Date(twoHoursAgo + index),
			})),
			{
				id: "mobile-key",
				userId: "user-1",
				source: "mobile",
				createdAt: new Date(0),
			},
			{
				id: "other-user-key",
				userId: "user-2",
				source: "desktop",
				createdAt: new Date(0),
			},
		);

		const issued: (string | null)[] = [];
		for (let index = 0; index < 5; index++) issued.push(await requestApiKey());

		expect(desktopKeys("user-1").map((row) => row.id)).toEqual([
			...Array.from({ length: 15 }, (_, index) => `old-${5 + index}`),
			...issued,
		]);
		expect(state.rows.map((row) => row.id)).toEqual(
			expect.arrayContaining(["mobile-key", "other-user-key"]),
		);
	});

	it("trims a long key history down to the 20 newest", async () => {
		for (let index = 0; index < 1030; index++) {
			state.rows.push({
				id: `old-${index}`,
				userId: "user-1",
				source: "desktop",
				createdAt: new Date(-1_000_000 + index),
			});
		}

		const apiKey = await requestApiKey();

		expect(desktopKeys("user-1").map((row) => row.id)).toEqual([
			...Array.from({ length: 19 }, (_, index) => `old-${1011 + index}`),
			apiKey,
		]);
	});

	it("locks the user's row before counting and adding a key", async () => {
		await requestApiKey();

		expect(state.events).toEqual(["lock:update:user-1", "count", "insert"]);
	});

	const request = async () => {
		const { app } = await import("@/app/api/desktop/[...route]/session");
		return app.request(
			"https://cap.example/request?type=api_key&platform=web&port=49152",
		);
	};

	it("issues no key once 20 desktop keys were made in the last hour", async () => {
		state.rows.push({
			id: "hour-old",
			userId: "user-1",
			source: "desktop",
			createdAt: new Date(state.base - 61 * 60 * 1000),
		});
		for (let index = 0; index < 20; index++) {
			expect(await requestApiKey()).toMatch(/^[0-9a-f-]{36}$/);
		}
		state.mints.clear();
		state.events = [];

		const refused = await request();

		expect(refused.status).toBe(429);
		expect(refused.headers.get("location")).toBeNull();
		expect(state.events).toEqual(["lock:update:user-1", "count"]);
		expect(desktopKeys("user-1")).toHaveLength(20);
	});

	it("keeps counting keys issued before a sign-out that deleted them", async () => {
		for (let index = 0; index < 20; index++) await requestApiKey();
		state.rows = [];
		state.events = [];

		const refused = await request();

		expect(refused.status).toBe(429);
		expect(state.events).toEqual([]);
		expect(state.rows).toHaveLength(0);
		expect(state.limiterCalls).toHaveLength(21);
		for (const call of state.limiterCalls) {
			expect(call).toEqual(["rl_desktop_key_mint", "desktop-key-mint:user-1"]);
		}
	});
});
