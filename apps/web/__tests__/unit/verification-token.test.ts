import { verificationTokens } from "@cap/database/schema";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { describe, expect, it } from "vitest";
import { DrizzleAdapter } from "../../../../packages/database/auth/drizzle-adapter";

type TokenRow = { identifier: string; token: string; expires: Date };

function parsePredicate(condition: SQL) {
	const query = new MySqlDialect().sqlToQuery(condition);
	const match = /^`verification_tokens`\.`(identifier|token)` = \?$/.exec(
		query.sql,
	);
	if (!match?.[1]) throw new Error(`Unexpected predicate: ${query.sql}`);
	return {
		column: match[1] as "identifier" | "token",
		value: query.params[0] as string,
	};
}

function fakeDatabase(initialRow: TokenRow) {
	let row: TokenRow | undefined = initialRow;
	const db = {
		select: () => ({
			from: () => ({
				where: (condition: SQL) => ({
					limit: async () => {
						if (!row) return [];
						const { column, value } = parsePredicate(condition);
						return row[column] === value ? [row] : [];
					},
				}),
			}),
		}),
		delete: () => ({
			where: async (condition: SQL) => {
				if (!row) return;
				const { column, value } = parsePredicate(condition);
				if (row[column] === value) row = undefined;
			},
		}),
	};
	return { db: db as unknown as MySql2Database, getRow: () => row };
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
});
