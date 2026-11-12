import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;
type Table = object;

const dialect = new MySqlDialect();

const comparable = (value: unknown) =>
	value instanceof Date
		? value.toISOString().slice(0, -1).replace("T", " ")
		: value;

const compare = (left: unknown, operator: string, right: unknown) => {
	const a = comparable(left);
	const b = comparable(right);
	if (a === null || a === undefined || b === null || b === undefined) {
		return false;
	}
	switch (operator) {
		case "=":
			return a === b;
		case "<>":
			return a !== b;
		case "<":
			return a < b;
		case "<=":
			return a <= b;
		case ">":
			return a > b;
		case ">=":
			return a >= b;
		default:
			throw new Error(`Unsupported operator ${operator}`);
	}
};

function compile(condition: SQL | undefined): Predicate {
	if (!condition) return () => true;
	const query = dialect.sqlToQuery(condition);
	const tokens =
		query.sql.match(/`[^`]+`(?:\.`[^`]+`)?|<>|<=|>=|[()=<>?,]|\w+/g) ?? [];
	const params = [...query.params];
	let position = 0;

	const peek = () => tokens[position]?.toLowerCase();
	const take = () => {
		const token = tokens[position];
		if (token === undefined) throw new Error(`Unexpected end: ${query.sql}`);
		position += 1;
		return token;
	};
	const expect = (expected: string) => {
		const token = take();
		if (token.toLowerCase() !== expected) {
			throw new Error(`Expected ${expected} in ${query.sql}`);
		}
	};
	const param = () => {
		expect("?");
		if (params.length === 0) throw new Error(`Missing parameter: ${query.sql}`);
		return params.shift();
	};

	const columnName = () => take().split(".").pop()?.replaceAll("`", "") ?? "";

	const binaryComparison = (): Predicate => {
		expect("cast");
		expect("(");
		const column = columnName();
		expect("as");
		expect("binary");
		expect(")");
		expect("=");
		expect("cast");
		expect("(");
		const value = param();
		expect("as");
		expect("binary");
		expect(")");
		return (row) => row[column] === value;
	};

	const comparison = (): Predicate => {
		if (peek() === "cast") return binaryComparison();
		const column = columnName();
		const operator = take().toLowerCase();
		if (operator === "is") {
			if (peek() === "not") {
				take();
				expect("null");
				return (row) => row[column] !== null && row[column] !== undefined;
			}
			expect("null");
			return (row) => row[column] === null || row[column] === undefined;
		}
		if (operator === "in") {
			expect("(");
			const values = [param()];
			while (peek() === ",") {
				take();
				values.push(param());
			}
			expect(")");
			return (row) => values.some((value) => compare(row[column], "=", value));
		}
		const value = param();
		return (row) => compare(row[column], operator, value);
	};

	const factor = (): Predicate => {
		if (peek() === "(") {
			take();
			const inner = expression();
			expect(")");
			return inner;
		}
		return comparison();
	};

	const term = (): Predicate => {
		const parts = [factor()];
		while (peek() === "and") {
			take();
			parts.push(factor());
		}
		return (row) => parts.every((part) => part(row));
	};

	const expression = (): Predicate => {
		const parts = [term()];
		while (peek() === "or") {
			take();
			parts.push(term());
		}
		return (row) => parts.some((part) => part(row));
	};

	const predicate = expression();
	if (position !== tokens.length) {
		throw new Error(`Could not read condition: ${query.sql}`);
	}
	return predicate;
}

const isSql = (value: unknown): value is SQL =>
	typeof value === "object" && value !== null && "queryChunks" in value;

const isQuery = (value: unknown): value is PromiseLike<Row[]> =>
	typeof value === "object" &&
	value !== null &&
	"then" in value &&
	typeof value.then === "function";

const columnName = (value: unknown) =>
	typeof value === "object" && value !== null && "name" in value
		? String((value as { name: unknown }).name)
		: null;

const isAggregate = (value: unknown) =>
	isSql(value) && /SUM\(|count\(\*\)/i.test(dialect.sqlToQuery(value).sql);

function rowExpression(row: Row, field: SQL) {
	const text = dialect.sqlToQuery(field).sql;
	const filled = text.match(
		/^\((?:`[^`]+`\.)?`([^`]+)` IS NOT NULL AND (?:`[^`]+`\.)?`\1` <> ''\)$/i,
	);
	if (!filled) throw new Error(`Unsupported expression ${text}`);
	const value = row[filled[1] ?? ""];
	return value !== null && value !== undefined && value !== "" ? 1 : 0;
}

function project(rows: Row[], fields: Record<string, unknown> | undefined) {
	if (!fields) return rows.map((row) => ({ ...row }));
	const aggregates = Object.entries(fields).filter(([, field]) =>
		isAggregate(field),
	);
	if (aggregates.length > 0) {
		const result: Row = {};
		for (const [alias, field] of Object.entries(fields)) {
			const text = dialect.sqlToQuery(field as SQL).sql;
			const sum = text.match(/SUM\((-?)(?:`[^`]+`\.)?`([^`]+)`\)/i);
			if (sum) {
				const sign = sum[1] === "-" ? -1 : 1;
				const column = sum[2] ?? "";
				result[alias] = rows.reduce(
					(total, row) => total + sign * (Number(row[column]) || 0),
					0,
				);
			} else if (/count\(\*\)/i.test(text)) {
				result[alias] = rows.length;
			} else {
				throw new Error(`Unsupported aggregate ${text}`);
			}
		}
		return [result];
	}
	return rows.map((row) =>
		Object.fromEntries(
			Object.entries(fields).map(([alias, field]) => [
				alias,
				isSql(field)
					? rowExpression(row, field)
					: row[columnName(field) ?? alias],
			]),
		),
	);
}

export function createFakeDatabase(defaults: Map<Table, () => Row>) {
	let tables = new Map<Table, Row[]>();
	let clock = Date.parse("2026-11-11T10:00:00.000Z");
	let queue: Promise<unknown> = Promise.resolve();
	const failures = { beforeCommit: 0 };

	const rowsOf = (table: Table) => {
		let rows = tables.get(table);
		if (!rows) {
			rows = [];
			tables.set(table, rows);
		}
		return rows;
	};

	const now = () => {
		clock += 1000;
		return new Date(clock);
	};

	const select = (fields?: Record<string, unknown>) => ({
		from: (table: Table) => {
			const state = {
				condition: undefined as SQL | undefined,
				ordered: false,
				limit: undefined as number | undefined,
				offset: 0,
			};
			const run = async () => {
				let rows = rowsOf(table).filter(compile(state.condition));
				if (state.ordered) {
					rows = [...rows].sort((a, b) => {
						const byDate =
							(b.createdAt as Date).getTime() - (a.createdAt as Date).getTime();
						return byDate !== 0
							? byDate
							: String(b.id).localeCompare(String(a.id));
					});
				}
				const scalars: Row = {};
				for (const [alias, field] of Object.entries(fields ?? {})) {
					const inner = isSql(field)
						? field.queryChunks.find(isQuery)
						: undefined;
					if (!inner) continue;
					const [first] = await inner;
					scalars[alias] = Object.values(first ?? {})[0] ?? null;
				}
				const selected = fields
					? Object.fromEntries(
							Object.entries(fields).filter(([alias]) => !(alias in scalars)),
						)
					: fields;
				const projected = project(rows, selected).map((row) => ({
					...row,
					...scalars,
				}));
				return projected.slice(
					state.offset,
					state.limit === undefined ? undefined : state.offset + state.limit,
				);
			};
			const chain = Object.assign(Promise.resolve().then(run), {
				where(condition: SQL | undefined) {
					state.condition = condition;
					return chain;
				},
				orderBy() {
					state.ordered = true;
					return chain;
				},
				limit(count: number) {
					state.limit = count;
					return chain;
				},
				offset(count: number) {
					state.offset = count;
					return chain;
				},
				for() {
					return chain;
				},
			});
			return chain;
		},
	});

	const insert = (table: Table) => ({
		values(values: Row) {
			const apply = async (ignoreDuplicate: boolean) => {
				const rows = rowsOf(table);
				if (rows.some((row) => row.id === values.id)) {
					if (ignoreDuplicate) return [{ affectedRows: 0 }];
					throw new Error(`Duplicate entry ${String(values.id)}`);
				}
				const timestamp = now();
				rows.push({
					...(defaults.get(table)?.() ?? {}),
					createdAt: timestamp,
					updatedAt: timestamp,
					...values,
				});
				return [{ affectedRows: 1 }];
			};
			const mode = { ignoreDuplicate: false };
			const pending = Object.assign(
				Promise.resolve().then(() => apply(mode.ignoreDuplicate)),
				{
					onDuplicateKeyUpdate() {
						mode.ignoreDuplicate = true;
						return pending;
					},
				},
			);
			return pending;
		},
	});

	const update = (table: Table) => ({
		set: (values: Row) => ({
			where: async (condition: SQL | undefined) => {
				const matches = rowsOf(table).filter(compile(condition));
				for (const row of matches) {
					for (const [key, value] of Object.entries(values)) {
						if (isSql(value)) {
							const query = dialect.sqlToQuery(value);
							const amount = Number(query.params.at(-1));
							row[key] =
								Number(row[key]) + (query.sql.includes("+") ? amount : -amount);
						} else if (value !== undefined) {
							row[key] = value;
						}
					}
					if (!("updatedAt" in values)) row.updatedAt = now();
				}
				return [{ affectedRows: matches.length }];
			},
		}),
	});

	const remove = (table: Table) => ({
		where: async (condition: SQL | undefined) => {
			const matches = new Set(rowsOf(table).filter(compile(condition)));
			tables.set(
				table,
				rowsOf(table).filter((row) => !matches.has(row)),
			);
			return [{ affectedRows: matches.size }];
		},
	});

	const client = { select, insert, update, delete: remove };

	const transaction = <T>(callback: (tx: typeof client) => Promise<T>) => {
		const run = async () => {
			const snapshot = [...tables.entries()].map(
				([table, rows]) => [table, structuredClone(rows)] as const,
			);
			try {
				const result = await callback(client);
				if (failures.beforeCommit > 0) {
					failures.beforeCommit -= 1;
					throw new Error("connection lost before commit");
				}
				return result;
			} catch (error) {
				tables = new Map(snapshot);
				throw error;
			}
		};
		const next = queue.then(run, run);
		queue = next.catch(() => {});
		return next;
	};

	return {
		db: { ...client, transaction },
		rows: (table: Table) => rowsOf(table),
		seed(table: Table, row: Row) {
			const timestamp = now();
			const seeded = {
				...(defaults.get(table)?.() ?? {}),
				createdAt: timestamp,
				updatedAt: timestamp,
				...row,
			};
			rowsOf(table).push(seeded);
			return seeded;
		},
		failNextCommit() {
			failures.beforeCommit += 1;
		},
		advance(milliseconds: number) {
			clock += milliseconds;
		},
		reset() {
			tables = new Map();
			failures.beforeCommit = 0;
			queue = Promise.resolve();
		},
	};
}
