import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { describe, expect, it } from "vitest";
import { DrizzleAdapter } from "../../../../packages/database/auth/drizzle-adapter";

interface VerificationTokenRow {
	identifier: string;
	token: string;
	expires: Date;
}

const dialect = new MySqlDialect();

function createMockDb(initialRows: VerificationTokenRow[]) {
	let table = [...initialRows];
	let lastDeleteQuery: { sql: string; params: unknown[] } | null = null;

	const db = {
		select: () => ({
			from: () => ({
				where: (pred: unknown) => {
					const query = dialect.sqlToQuery(pred as SQL);
					const identifierParam = String(query.params[0] ?? "").toLowerCase();
					return {
						limit: async () =>
							table
								.filter(
									(row) => row.identifier.toLowerCase() === identifierParam,
								)
								.slice(0, 1),
					};
				},
			}),
		}),
		delete: () => ({
			where: (pred: unknown) => {
				const query = dialect.sqlToQuery(pred as SQL);
				lastDeleteQuery = query;
				const [identifierParam, tokenParam] = query.params;
				const initialCount = table.length;
				table = table.filter(
					(row) =>
						!(row.identifier === identifierParam && row.token === tokenParam),
				);
				const affectedRows = initialCount - table.length;
				return Promise.resolve([{ affectedRows }]);
			},
		}),
		transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
		getTable: () => table,
		getLastDeleteQuery: () => lastDeleteQuery,
	};

	return db;
}

describe("useVerificationToken", () => {
	it("burns the token on wrong guess and returns null", async () => {
		const mockDb = createMockDb([
			{
				identifier: "user@example.com",
				token: "123456",
				expires: new Date(Date.now() + 600000),
			},
		]);

		const adapter = DrizzleAdapter(mockDb as unknown as MySql2Database);
		const result = await adapter.useVerificationToken?.({
			identifier: "USER@example.com",
			token: "999999",
		});

		expect(result).toBeNull();
		const deleteQuery = mockDb.getLastDeleteQuery();
		expect(deleteQuery).not.toBeNull();
		expect(deleteQuery?.sql).toContain(
			"`verification_tokens`.`identifier` = ?",
		);
		expect(deleteQuery?.sql).toContain("`verification_tokens`.`token` = ?");
		expect(deleteQuery?.params).toEqual(["user@example.com", "123456"]);
		expect(mockDb.getTable()).toHaveLength(0);
	});

	it("returns token and invalidates it on correct guess", async () => {
		const mockDb = createMockDb([
			{
				identifier: "user@example.com",
				token: "123456",
				expires: new Date(Date.now() + 600000),
			},
		]);

		const adapter = DrizzleAdapter(mockDb as unknown as MySql2Database);
		const result = await adapter.useVerificationToken?.({
			identifier: "USER@example.com",
			token: "123456",
		});

		expect(result).not.toBeNull();
		expect(result?.identifier).toBe("user@example.com");
		expect(result?.token).toBe("123456");
		const deleteQuery = mockDb.getLastDeleteQuery();
		expect(deleteQuery).not.toBeNull();
		expect(deleteQuery?.sql).toContain(
			"`verification_tokens`.`identifier` = ?",
		);
		expect(deleteQuery?.sql).toContain("`verification_tokens`.`token` = ?");
		expect(deleteQuery?.params).toEqual(["user@example.com", "123456"]);
		expect(mockDb.getTable()).toHaveLength(0);
	});

	it("returns null if token does not exist", async () => {
		const mockDb = createMockDb([]);

		const adapter = DrizzleAdapter(mockDb as unknown as MySql2Database);
		const result = await adapter.useVerificationToken?.({
			identifier: "nonexistent@example.com",
			token: "123456",
		});

		expect(result).toBeNull();
		expect(mockDb.getLastDeleteQuery()).toBeNull();
	});

	it("prevents race condition by checking affectedRows on token consumption", async () => {
		let table = [
			{
				identifier: "user@example.com",
				token: "123456",
				expires: new Date(Date.now() + 600000),
			},
		];

		let firstDeleteDone = false;
		const mockDb = {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => table.slice(0, 1),
					}),
				}),
			}),
			delete: () => ({
				where: (pred: unknown) => {
					const query = dialect.sqlToQuery(pred as SQL);
					expect(query.sql).toContain("`verification_tokens`.`identifier` = ?");
					expect(query.sql).toContain("`verification_tokens`.`token` = ?");
					if (!firstDeleteDone) {
						firstDeleteDone = true;
						table = [];
						return Promise.resolve([{ affectedRows: 1 }]);
					}
					return Promise.resolve([{ affectedRows: 0 }]);
				},
			}),
			transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
		} as unknown as MySql2Database;

		const adapter = DrizzleAdapter(mockDb);

		const firstResult = await adapter.useVerificationToken?.({
			identifier: "USER@example.com",
			token: "123456",
		});

		expect(firstResult).not.toBeNull();
		expect(firstResult?.token).toBe("123456");

		const secondResult = await adapter.useVerificationToken?.({
			identifier: "USER@example.com",
			token: "123456",
		});

		expect(secondResult).toBeNull();
	});

	it("deletes only the selected token instance and preserves replacement tokens for the same user", async () => {
		const mockDb = createMockDb([
			{
				identifier: "user@example.com",
				token: "123456",
				expires: new Date(Date.now() + 600000),
			},
			{
				identifier: "user@example.com",
				token: "replacement_token",
				expires: new Date(Date.now() + 600000),
			},
		]);

		const adapter = DrizzleAdapter(mockDb as unknown as MySql2Database);
		const result = await adapter.useVerificationToken?.({
			identifier: "USER@example.com",
			token: "999999",
		});

		expect(result).toBeNull();
		const remaining = mockDb.getTable();
		expect(remaining.some((r) => r.token === "123456")).toBe(false);
		expect(remaining.some((r) => r.token === "replacement_token")).toBe(true);
	});
});
