import { and, eq, sql } from "drizzle-orm";
import type { AnyMySqlColumn } from "drizzle-orm/mysql-core";

export const USER_SCOPE_PARAMETERS = ["userId", "externalUserId"] as const;

export type DeveloperUserScope =
	| { ok: true; userId: string | undefined }
	| { ok: false; code: string; message: string; hint: string };

const refuse = (code: string, message: string, hint: string) =>
	({ ok: false, code, message, hint }) as const;

function parseUserScope(
	queries: Record<string, string[]>,
	withoutFilter: string,
): DeveloperUserScope {
	const repeated = Object.keys(queries).find(
		(name) => (queries[name]?.length ?? 0) > 1,
	);
	if (repeated !== undefined) {
		return refuse(
			"repeated_parameter",
			`Query parameter ${repeated.slice(0, 64)} was sent more than once`,
			"Send each query parameter once.",
		);
	}

	const empty = USER_SCOPE_PARAMETERS.find(
		(name) => queries[name]?.[0]?.trim() === "",
	);
	if (empty !== undefined) {
		return refuse(
			"invalid_user_id",
			"userId filter is empty",
			`Send the user ID to filter by, or leave ${empty} out ${withoutFilter}.`,
		);
	}

	const userId = queries.userId?.[0]?.trim();
	const externalUserId = queries.externalUserId?.[0]?.trim();
	if (
		userId !== undefined &&
		externalUserId !== undefined &&
		userId !== externalUserId
	) {
		return refuse(
			"conflicting_parameters",
			"userId and externalUserId name the same filter",
			"Send one of them, or the same value in both.",
		);
	}

	return { ok: true, userId: userId ?? externalUserId };
}

export const parseDeveloperUserScope = (queries: Record<string, string[]>) =>
	parseUserScope(queries, "to list every video");

export function parseDeveloperVideoScope(
	queries: Record<string, string[]>,
): DeveloperUserScope {
	const unknown = Object.keys(queries).find(
		(name) => !USER_SCOPE_PARAMETERS.some((allowed) => allowed === name),
	);
	if (unknown !== undefined) {
		return refuse(
			"unknown_parameter",
			`Unknown query parameter ${unknown.slice(0, 64)}`,
			`This endpoint accepts ${USER_SCOPE_PARAMETERS.join(", ")}. Parameter names are case-sensitive.`,
		);
	}
	return parseUserScope(queries, "to reach any video of the app");
}

// The column's collation treats case and accent variants as equal, so two
// different user IDs could match each other. The plain equality keeps the
// lookup on the (appId, externalUserId) index and the binary comparison then
// drops every row that is not the same bytes.
export const exactUserIdMatch = (column: AnyMySqlColumn, userId: string) =>
	and(
		eq(column, userId),
		sql`CAST(${column} AS BINARY) = CAST(${userId} AS BINARY)`,
	);
