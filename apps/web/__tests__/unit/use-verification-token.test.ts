import type { MySql2Database } from "drizzle-orm/mysql2";
import { describe, expect, it, vi } from "vitest";
import { DrizzleAdapter } from "../../../../packages/database/auth/drizzle-adapter";

function createMockDb(initialRow?: {
	identifier: string;
	token: string;
	expires: Date;
}) {
	let row = initialRow;
	let deleted = false;

	const createChain = () => {
		const chain = {
			for: vi.fn(() => chain),
			limit: vi.fn(() => Promise.resolve(row ? [row] : [])),
		};
		return chain;
	};

	const db = {
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => createChain()),
			})),
		})),
		delete: vi.fn(() => ({
			where: vi.fn(() => {
				deleted = true;
				row = undefined;
				return Promise.resolve([]);
			}),
		})),
	} as unknown as MySql2Database;

	return {
		db,
		wasDeleted: () => deleted,
	};
}

describe("DrizzleAdapter.useVerificationToken", () => {
	it("burns token immediately and returns null on wrong token guess", async () => {
		const targetEmail = "victim@example.com";
		const realToken = "847291";
		const wrongGuess = "123456";
		const expires = new Date(Date.now() + 600_000);

		const mock = createMockDb({
			identifier: targetEmail,
			token: realToken,
			expires,
		});

		const adapter = DrizzleAdapter(mock.db, { getSsoIdentity: () => null });
		if (!adapter.useVerificationToken)
			throw new Error("useVerificationToken not implemented");

		const result = await adapter.useVerificationToken({
			identifier: targetEmail,
			token: wrongGuess,
		});

		expect(result).toBeNull();
		expect(mock.wasDeleted()).toBe(true);
	});

	it("burns token and returns null when token has expired", async () => {
		const targetEmail = "user@example.com";
		const token = "654321";
		const expiredDate = new Date(Date.now() - 10_000);

		const mock = createMockDb({
			identifier: targetEmail,
			token,
			expires: expiredDate,
		});

		const adapter = DrizzleAdapter(mock.db, { getSsoIdentity: () => null });
		if (!adapter.useVerificationToken)
			throw new Error("useVerificationToken not implemented");

		const result = await adapter.useVerificationToken({
			identifier: targetEmail,
			token,
		});

		expect(result).toBeNull();
		expect(mock.wasDeleted()).toBe(true);
	});

	it("burns token and returns valid token object when token and identifier match", async () => {
		const targetEmail = "User@Example.Com";
		const validToken = "998877";
		const expires = new Date(Date.now() + 600_000);

		const mock = createMockDb({
			identifier: targetEmail.toLowerCase(),
			token: validToken,
			expires,
		});

		const adapter = DrizzleAdapter(mock.db, { getSsoIdentity: () => null });
		if (!adapter.useVerificationToken)
			throw new Error("useVerificationToken not implemented");

		const result = await adapter.useVerificationToken({
			identifier: targetEmail,
			token: validToken,
		});

		expect(result).not.toBeNull();
		expect(result?.token).toBe(validToken);
		expect(result?.identifier).toBe(targetEmail.toLowerCase());
		expect(mock.wasDeleted()).toBe(true);
	});

	it("returns null without deleting when no token exists for identifier", async () => {
		const mock = createMockDb(undefined);

		const adapter = DrizzleAdapter(mock.db, { getSsoIdentity: () => null });
		if (!adapter.useVerificationToken)
			throw new Error("useVerificationToken not implemented");

		const result = await adapter.useVerificationToken({
			identifier: "nonexistent@example.com",
			token: "111111",
		});

		expect(result).toBeNull();
		expect(mock.wasDeleted()).toBe(false);
	});

	it("ensures atomic single consumption under concurrent verification attempts", async () => {
		const targetEmail = "concurrent@example.com";
		const validToken = "554433";
		const expires = new Date(Date.now() + 600_000);

		let tokenRecord:
			| {
					identifier: string;
					token: string;
					expires: Date;
			  }
			| undefined = {
			identifier: targetEmail,
			token: validToken,
			expires,
		};

		let lock = Promise.resolve();

		const mockDb = {
			transaction: vi.fn(
				async (cb: (tx: MySql2Database) => Promise<unknown>) => {
					const currentLock = lock;
					let releaseLock: () => void = () => {};
					lock = new Promise((resolve) => {
						releaseLock = resolve;
					});
					await currentLock;
					try {
						const tx = {
							select: vi.fn(() => ({
								from: vi.fn(() => ({
									where: vi.fn(() => ({
										for: vi.fn(() => ({
											limit: vi.fn(() =>
												Promise.resolve(tokenRecord ? [tokenRecord] : []),
											),
										})),
									})),
								})),
							})),
							delete: vi.fn(() => ({
								where: vi.fn(() => {
									tokenRecord = undefined;
									return Promise.resolve([]);
								}),
							})),
						} as unknown as MySql2Database;
						return await cb(tx);
					} finally {
						releaseLock();
					}
				},
			),
		} as unknown as MySql2Database;

		const adapter = DrizzleAdapter(mockDb, { getSsoIdentity: () => null });
		if (!adapter.useVerificationToken)
			throw new Error("useVerificationToken not implemented");

		const [result1, result2] = await Promise.all([
			adapter.useVerificationToken({
				identifier: targetEmail,
				token: validToken,
			}),
			adapter.useVerificationToken({
				identifier: targetEmail,
				token: validToken,
			}),
		]);

		const successCount = [result1, result2].filter((r) => r !== null).length;
		const nullCount = [result1, result2].filter((r) => r === null).length;
		expect(successCount).toBe(1);
		expect(nullCount).toBe(1);
	});
});
