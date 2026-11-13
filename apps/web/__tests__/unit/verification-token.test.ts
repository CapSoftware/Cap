import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { describe, expect, it } from "vitest";
import { DrizzleAdapter } from "../../../../packages/database/auth/drizzle-adapter";

type TokenRow = { identifier: string; token: string; expires: Date };

function matchesPredicate(condition: SQL, row: TokenRow) {
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
}

function fakeDatabase(
	initialRow: TokenRow,
	options?: { afterSelect?: () => void },
) {
	let row: TokenRow | undefined = initialRow;
	const db = {
		select: () => ({
			from: () => ({
				where: (condition: SQL) => ({
					limit: async () => {
						const result = row && matchesPredicate(condition, row) ? [row] : [];
						options?.afterSelect?.();
						return result;
					},
				}),
			}),
		}),
		delete: () => ({
			where: async (condition: SQL) => {
				if (row && matchesPredicate(condition, row)) {
					row = undefined;
					return [{ affectedRows: 1 }];
				}
				return [{ affectedRows: 0 }];
			},
		}),
	};
	return {
		db: db as unknown as MySql2Database,
		getRow: () => row,
		setRow: (next: TokenRow) => {
			row = next;
		},
	};
}

describe("useVerificationToken", () => {
	const identifier = "person@example.com";
	const validRow: TokenRow = {
		identifier,
		token: "111111",
		expires: new Date(Date.now() + 60_000),
	};

	it("burns the code on a wrong guess instead of leaving it guessable", async () => {
		const { db, getRow } = fakeDatabase({ ...validRow });
		const adapter = DrizzleAdapter(db);

		const wrongGuess = await adapter.useVerificationToken?.({
			identifier,
			token: "000000",
		});

		expect(wrongGuess).toBeNull();
		expect(getRow()).toBeUndefined();

		const correctGuessAfterward = await adapter.useVerificationToken?.({
			identifier,
			token: "111111",
		});
		expect(correctGuessAfterward).toBeNull();
	});

	it("returns the row and deletes it on a correct guess", async () => {
		const { db, getRow } = fakeDatabase({ ...validRow });
		const adapter = DrizzleAdapter(db);

		const result = await adapter.useVerificationToken?.({
			identifier,
			token: "111111",
		});

		expect(result).toMatchObject({ identifier, token: "111111" });
		expect(getRow()).toBeUndefined();
	});

	it("returns null when no code was ever requested for the identifier", async () => {
		const { db } = fakeDatabase({ ...validRow });
		const adapter = DrizzleAdapter(db);

		const result = await adapter.useVerificationToken?.({
			identifier: "nobody@example.com",
			token: "111111",
		});

		expect(result).toBeNull();
	});

	it("lets only one of two concurrent correct guesses succeed", async () => {
		const { db, getRow } = fakeDatabase({ ...validRow });
		const adapter = DrizzleAdapter(db);

		const [first, second] = await Promise.all([
			adapter.useVerificationToken?.({ identifier, token: "111111" }),
			adapter.useVerificationToken?.({ identifier, token: "111111" }),
		]);

		const successes = [first, second].filter((result) => result !== null);
		expect(successes).toHaveLength(1);
		expect(getRow()).toBeUndefined();
	});

	it("does not delete a resent code that replaced the row a guess read", async () => {
		const resentRow: TokenRow = {
			identifier,
			token: "222222",
			expires: new Date(Date.now() + 60_000),
		};
		const { db, getRow, setRow } = fakeDatabase(
			{ ...validRow },
			{
				afterSelect: () => setRow({ ...resentRow }),
			},
		);
		const adapter = DrizzleAdapter(db);

		const wrongGuessAgainstStaleCode = await adapter.useVerificationToken?.({
			identifier,
			token: "000000",
		});

		expect(wrongGuessAgainstStaleCode).toBeNull();
		expect(getRow()).toEqual(resentRow);
	});
});
