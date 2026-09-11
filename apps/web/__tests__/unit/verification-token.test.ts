import type { MySql2Database } from "drizzle-orm/mysql2";
import { describe, expect, it } from "vitest";
import { DrizzleAdapter } from "../../../../packages/database/auth/drizzle-adapter";

interface VerificationTokenRow {
	identifier: string;
	token: string;
	expires: Date;
}

function createMockDb(initialRows: VerificationTokenRow[]) {
	let table = [...initialRows];
	let deletePredicate: unknown = null;

	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => table.slice(0, 1),
				}),
			}),
		}),
		delete: () => ({
			where: (pred: unknown) => {
				deletePredicate = pred;
				const initialCount = table.length;
				table = table.filter(
					(row) =>
						!(
							row.identifier.toLowerCase() === "user@example.com" &&
							row.token === "123456"
						),
				);
				const rowsAffected = initialCount - table.length;
				return Promise.resolve({ rowsAffected });
			},
		}),
		transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
		getTable: () => table,
		getDeletePredicate: () => deletePredicate,
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
		expect(mockDb.getDeletePredicate()).not.toBeNull();
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
		expect(mockDb.getDeletePredicate()).not.toBeNull();
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
		expect(mockDb.getDeletePredicate()).toBeNull();
	});

	it("prevents race condition by checking rowsAffected on token consumption", async () => {
		let table = [
			{
				identifier: "user@example.com",
				token: "123456",
				expires: new Date(Date.now() + 600000),
			},
		];

		const mockDb = {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => table.slice(0, 1),
					}),
				}),
			}),
			delete: () => ({
				where: () => {
					const initialCount = table.length;
					table = [];
					const rowsAffected = initialCount;
					return Promise.resolve({ rowsAffected });
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
		let table = [
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
		];

		const mockDb = {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => [table[0]],
					}),
				}),
			}),
			delete: () => ({
				where: () => {
					const initialCount = table.length;
					table = table.filter(
						(row) =>
							!(
								row.identifier === "user@example.com" && row.token === "123456"
							),
					);
					const rowsAffected = initialCount - table.length;
					return Promise.resolve({ rowsAffected });
				},
			}),
			transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
		} as unknown as MySql2Database;

		const adapter = DrizzleAdapter(mockDb);
		const result = await adapter.useVerificationToken?.({
			identifier: "USER@example.com",
			token: "999999",
		});

		expect(result).toBeNull();
		expect(table.some((r) => r.token === "123456")).toBe(false);
		expect(table.some((r) => r.token === "replacement_token")).toBe(true);
	});
});
