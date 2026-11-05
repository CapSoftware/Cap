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
}));

const dialect = new MySqlDialect();
const params = (condition: SQL) => dialect.sqlToQuery(condition).params;

function keysTable() {
	const insert = () => ({
		values: async (value: Omit<KeyRow, "createdAt">) => {
			state.clock += 1;
			state.rows.push({ ...value, createdAt: new Date(state.clock * 1000) });
		},
	});
	const select = () => ({
		from: () => ({
			where: (condition: SQL) => ({
				orderBy: () => ({
					limit: (limit: number) => ({
						offset: async (offset: number) => {
							const [userId, source, excludedId] = params(condition);
							return state.rows
								.filter(
									(row) =>
										row.userId === userId &&
										row.source === source &&
										row.id !== excludedId,
								)
								.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
								.slice(offset, offset + limit)
								.map((row) => ({ id: row.id }));
						},
					}),
				}),
			}),
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
});
