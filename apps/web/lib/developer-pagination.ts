export const MAX_DEVELOPER_API_OFFSET = 1_000_000_000;
export const DEFAULT_DEVELOPER_API_LIMIT = 50;
export const MAX_DEVELOPER_API_LIMIT = 100;

export type DeveloperListQuery =
	| { ok: true; limit: number; offset: number }
	| { ok: false; code: string; message: string; hint: string };

const refuse = (code: string, message: string, hint: string) =>
	({ ok: false, code, message, hint }) as const;

function wholeNumber(raw: string | undefined, min: number, max: number) {
	if (raw === undefined) return undefined;
	if (!/^\d+$/.test(raw)) return null;
	const value = Number(raw);
	return value >= min && value <= max ? value : null;
}

export function parseDeveloperVideosPagination(
	rawLimit: string | undefined,
	rawOffset: string | undefined,
): DeveloperListQuery {
	const limit = wholeNumber(rawLimit, 1, MAX_DEVELOPER_API_LIMIT);
	if (limit === null) {
		return refuse(
			"invalid_limit",
			"limit is not valid",
			`Send a whole number from 1 to ${MAX_DEVELOPER_API_LIMIT}, or leave it out for ${DEFAULT_DEVELOPER_API_LIMIT}.`,
		);
	}

	const offset = wholeNumber(rawOffset, 0, MAX_DEVELOPER_API_OFFSET);
	if (offset === null) {
		return refuse(
			"invalid_offset",
			"offset is not valid",
			`Send a whole number from 0 to ${MAX_DEVELOPER_API_OFFSET}, or leave it out to start at the first result.`,
		);
	}

	return {
		ok: true,
		limit: limit ?? DEFAULT_DEVELOPER_API_LIMIT,
		offset: offset ?? 0,
	};
}

export function parseDeveloperListQuery(
	query: Record<string, string>,
	filters: readonly string[],
): DeveloperListQuery {
	const allowed = [...filters, "limit", "offset"];
	const unknown = Object.keys(query).find((name) => !allowed.includes(name));
	if (unknown !== undefined) {
		return refuse(
			"unknown_parameter",
			`Unknown query parameter ${unknown.slice(0, 64)}`,
			`This list accepts ${allowed.join(", ")}. Parameter names are case-sensitive.`,
		);
	}
	return parseDeveloperVideosPagination(query.limit, query.offset);
}
