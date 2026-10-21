import { parseArgs } from "node:util";
import mysql from "mysql2/promise";
import pg from "pg";

const { values } = parseArgs({
	options: {
		mysql: { type: "string", default: process.env.MYSQL_URL },
		postgres: { type: "string", default: process.env.DATABASE_URL },
		truncate: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
	},
});

if (!values.mysql) throw new Error("Pass --mysql or set MYSQL_URL");
if (!values.postgres) throw new Error("Pass --postgres or set DATABASE_URL");
if (!/^postgres(ql)?:\/\//.test(values.postgres))
	throw new Error("--postgres must be a postgres:// URL");

const source = await mysql.createConnection({
	uri: values.mysql,
	dateStrings: true,
	supportBigNumbers: true,
	bigNumberStrings: true,
});
const target = new pg.Client({ connectionString: values.postgres });
await target.connect();

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const stripNul = (value) =>
	value.replaceAll("\u0000", "").replaceAll("\\u0000", "");

const { rows: tableRows } = await target.query(
	`SELECT table_name AS name FROM information_schema.tables
	 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
);
const tables = new Set(tableRows.map((row) => row.name));

const { rows: dependencies } = await target.query(
	`SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
	 FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
);
const ordered = [];
const visiting = new Set();
const visit = (table) => {
	if (ordered.includes(table)) return;
	if (visiting.has(table))
		throw new Error(`Circular foreign key involving ${table}`);
	visiting.add(table);
	for (const dependency of dependencies)
		if (dependency.child.replaceAll('"', "") === table)
			visit(dependency.parent.replaceAll('"', ""));
	visiting.delete(table);
	ordered.push(table);
};
for (const table of [...tables].sort()) visit(table);

const [sourceTables] = await source.query(
	"SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'",
);
const sourceNames = new Set(sourceTables.map((row) => row.name));

const summary = [];
for (const table of ordered) {
	if (!sourceNames.has(table)) {
		summary.push({ table, copied: 0, note: "not in MySQL" });
		continue;
	}
	const { rows: columns } = await target.query(
		`SELECT column_name AS name, data_type AS type FROM information_schema.columns
		 WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER'
		 ORDER BY ordinal_position`,
		[table],
	);
	const [sourceColumns] = await source.query(
		"SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?",
		[table],
	);
	const sourceTypes = new Map(sourceColumns.map((c) => [c.name, c.type]));
	const copied = columns.filter((column) => sourceTypes.has(column.name));

	const { rows: existing } = await target.query(
		`SELECT EXISTS (SELECT 1 FROM ${quote(table)}) AS present`,
	);
	if (existing[0].present && !values.truncate) {
		throw new Error(
			`${table} already has rows in PostgreSQL. Re-run with --truncate to replace them.`,
		);
	}

	const [{ total }] = (
		await source.query(`SELECT COUNT(*) AS total FROM \`${table}\``)
	)[0];
	if (values["dry-run"]) {
		summary.push({ table, copied: Number(total), note: "dry run" });
		continue;
	}

	const selectList = copied
		.map((column) =>
			sourceTypes.get(column.name) === "json"
				? `CAST(\`${column.name}\` AS CHAR CHARACTER SET utf8mb4) AS \`${column.name}\``
				: `\`${column.name}\``,
		)
		.join(", ");
	const batchSize = Math.max(
		1,
		Math.min(1000, Math.floor(60000 / copied.length)),
	);
	const columnList = copied.map((column) => quote(column.name)).join(", ");

	const convert = (column, value) => {
		if (value === null || value === undefined) return null;
		if (column.type === "boolean") return Boolean(Number(value));
		if (column.type === "jsonb") return stripNul(String(value));
		if (typeof value === "string") return stripNul(value);
		return value;
	};

	const flush = async (batch) => {
		if (batch.length === 0) return;
		const params = [];
		const rows = batch.map((row) => {
			const placeholders = copied.map((column, index) => {
				params.push(convert(column, row[index]));
				return `$${params.length}${column.type === "jsonb" ? "::jsonb" : ""}`;
			});
			return `(${placeholders.join(", ")})`;
		});
		await target.query(
			`INSERT INTO ${quote(table)} (${columnList}) VALUES ${rows.join(", ")}`,
			params,
		);
	};

	await target.query("BEGIN");
	try {
		if (values.truncate)
			await target.query(`TRUNCATE TABLE ${quote(table)} CASCADE`);
		const stream = source.connection
			.query({
				sql: `SELECT ${selectList} FROM \`${table}\``,
				rowsAsArray: true,
			})
			.stream({ highWaterMark: batchSize });
		let batch = [];
		for await (const row of stream) {
			batch.push(row);
			if (batch.length >= batchSize) {
				await flush(batch);
				batch = [];
			}
		}
		await flush(batch);
		const { rows: counted } = await target.query(
			`SELECT COUNT(*) AS total FROM ${quote(table)}`,
		);
		if (Number(counted[0].total) !== Number(total)) {
			throw new Error(
				`${table}: copied ${counted[0].total} rows but MySQL has ${total}`,
			);
		}
		await target.query("COMMIT");
		summary.push({ table, copied: Number(total) });
	} catch (error) {
		await target.query("ROLLBACK");
		throw new Error(`Failed copying ${table}: ${error.message}`, {
			cause: error,
		});
	}
}

const normalized = [];
if (!values["dry-run"]) {
	for (const [table, column] of [
		["users", "email"],
		["organization_invites", "invitedEmail"],
		["video_viewer_grants", "email"],
		["verification_tokens", "identifier"],
	]) {
		const result = await target.query(
			`UPDATE ${quote(table)} SET ${quote(column)} = lower(${quote(column)}) WHERE ${quote(column)} <> lower(${quote(column)})`,
		);
		if (result.rowCount)
			normalized.push({ table, column, rows: result.rowCount });
	}
}

console.table(summary);
if (normalized.length > 0) {
	console.log("Lowercased email addresses to match how Cap looks them up:");
	console.table(normalized);
}
console.log(
	values["dry-run"]
		? "Dry run complete. No data was written."
		: `Copied ${summary.reduce((sum, row) => sum + row.copied, 0)} rows across ${summary.length} tables.`,
);
await source.end();
await target.end();
