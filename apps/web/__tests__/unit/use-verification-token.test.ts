import type { MySql2Database } from "drizzle-orm/mysql2";
import { describe, expect, it, vi } from "vitest";
import { DrizzleAdapter } from "../../../../packages/database/auth/drizzle-adapter";

describe("DrizzleAdapter.useVerificationToken", () => {
	it("burns token immediately and returns null on wrong token guess", async () => {
		const targetEmail = "victim@example.com";
		const realToken = "847291";
		const wrongGuess = "123456";
		const expires = new Date(Date.now() + 600_000);

		let deleted = false;
		const mockDb = {
			select: vi.fn(() => ({
				from: vi.fn(() => ({
					where: vi.fn(() => ({
						limit: vi.fn(() =>
							Promise.resolve([
								{
									identifier: targetEmail,
									token: realToken,
									expires,
								},
							]),
						),
					})),
				})),
			})),
			delete: vi.fn(() => ({
				where: vi.fn(() => {
					deleted = true;
					return Promise.resolve([]);
				}),
			})),
		} as unknown as MySql2Database;

		const adapter = DrizzleAdapter(mockDb, { getSsoIdentity: () => null });
		if (!adapter.useVerificationToken)
			throw new Error("useVerificationToken not implemented");

		const result = await adapter.useVerificationToken({
			identifier: targetEmail,
			token: wrongGuess,
		});

		expect(result).toBeNull();
		expect(deleted).toBe(true);
		expect(mockDb.delete).toHaveBeenCalledTimes(1);
	});

	it("burns token and returns null when token has expired", async () => {
		const targetEmail = "user@example.com";
		const token = "654321";
		const expiredDate = new Date(Date.now() - 10_000);

		let deleted = false;
		const mockDb = {
			select: vi.fn(() => ({
				from: vi.fn(() => ({
					where: vi.fn(() => ({
						limit: vi.fn(() =>
							Promise.resolve([
								{
									identifier: targetEmail,
									token,
									expires: expiredDate,
								},
							]),
						),
					})),
				})),
			})),
			delete: vi.fn(() => ({
				where: vi.fn(() => {
					deleted = true;
					return Promise.resolve([]);
				}),
			})),
		} as unknown as MySql2Database;

		const adapter = DrizzleAdapter(mockDb, { getSsoIdentity: () => null });
		if (!adapter.useVerificationToken)
			throw new Error("useVerificationToken not implemented");

		const result = await adapter.useVerificationToken({
			identifier: targetEmail,
			token: token,
		});

		expect(result).toBeNull();
		expect(deleted).toBe(true);
	});

	it("burns token and returns valid token object when token and identifier match", async () => {
		const targetEmail = "User@Example.Com";
		const validToken = "998877";
		const expires = new Date(Date.now() + 600_000);

		let deleted = false;
		const mockDb = {
			select: vi.fn(() => ({
				from: vi.fn(() => ({
					where: vi.fn(() => ({
						limit: vi.fn(() =>
							Promise.resolve([
								{
									identifier: targetEmail.toLowerCase(),
									token: validToken,
									expires,
								},
							]),
						),
					})),
				})),
			})),
			delete: vi.fn(() => ({
				where: vi.fn(() => {
					deleted = true;
					return Promise.resolve([]);
				}),
			})),
		} as unknown as MySql2Database;

		const adapter = DrizzleAdapter(mockDb, { getSsoIdentity: () => null });
		if (!adapter.useVerificationToken)
			throw new Error("useVerificationToken not implemented");

		const result = await adapter.useVerificationToken({
			identifier: targetEmail,
			token: validToken,
		});

		expect(result).not.toBeNull();
		expect(result?.token).toBe(validToken);
		expect(result?.identifier).toBe(targetEmail.toLowerCase());
		expect(deleted).toBe(true);
	});

	it("returns null without deleting when no token exists for identifier", async () => {
		const mockDb = {
			select: vi.fn(() => ({
				from: vi.fn(() => ({
					where: vi.fn(() => ({
						limit: vi.fn(() => Promise.resolve([])),
					})),
				})),
			})),
			delete: vi.fn(() => ({
				where: vi.fn(() => Promise.resolve([])),
			})),
		} as unknown as MySql2Database;

		const adapter = DrizzleAdapter(mockDb, { getSsoIdentity: () => null });
		if (!adapter.useVerificationToken)
			throw new Error("useVerificationToken not implemented");

		const result = await adapter.useVerificationToken({
			identifier: "nonexistent@example.com",
			token: "111111",
		});

		expect(result).toBeNull();
		expect(mockDb.delete).not.toHaveBeenCalled();
	});
});
