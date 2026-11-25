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
	userId: "user-1",
	events: [] as string[],
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
			state.rows.push({ ...value, createdAt: new Date(state.clock * 1000) });
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
		state.userId = "user-1";
		state.events = [];
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
		state.rows.push(
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
		for (let index = 0; index < 25; index++) issued.push(await requestApiKey());

		expect(desktopKeys("user-1").map((row) => row.id)).toEqual(issued.slice(5));
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

	it("issues no key once 20 desktop keys were made in the last hour", async () => {
		const now = Date.now();
		const recent = (id: string, minutesAgo: number, source = "desktop") => ({
			id,
			userId: "user-1",
			source,
			createdAt: new Date(now - minutesAgo * 60_000),
		});
		state.rows.push(
			...Array.from({ length: 19 }, (_, index) =>
				recent(`recent-${index}`, 50 - index),
			),
			recent("hour-old", 61),
			recent("extension-key", 5, "extension"),
		);
		expect(await requestApiKey()).toMatch(/^[0-9a-f-]{36}$/);

		state.rows.push(recent("recent-19", 1));
		state.events = [];
		const before = state.rows.length;
		const { app } = await import("@/app/api/desktop/[...route]/session");
		const refused = await app.request(
			"https://cap.example/request?type=api_key&platform=web&port=49152",
		);

		expect(refused.status).toBe(429);
		expect(refused.headers.get("location")).toBeNull();
		expect(state.events).toEqual(["lock:update:user-1", "count"]);
		expect(state.rows).toHaveLength(before);
	});
});
