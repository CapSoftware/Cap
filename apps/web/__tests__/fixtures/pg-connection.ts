import pg from "pg";

export type RowDataPacket = Record<string, any>;

export type TestConnection = {
	execute<T = RowDataPacket[]>(
		sql: string,
		params?: unknown[],
	): Promise<[T, pg.FieldDef[]]>;
	query<T = RowDataPacket[]>(
		sql: string,
		params?: unknown[],
	): Promise<[T, pg.FieldDef[]]>;
	truncateAll(): Promise<void>;
	end(): Promise<void>;
};

export async function createTestConnection(
	connectionString: string,
): Promise<TestConnection> {
	pg.types.setTypeParser(pg.types.builtins.INT8, Number);
	pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
	const client = new pg.Client({ connectionString });
	await client.connect();
	const run = async <T>(sql: string, params?: unknown[]) => {
		const result = await client.query(sql, params);
		return [result.rows as T, result.fields] as [T, pg.FieldDef[]];
	};
	return {
		execute: run,
		query: run,
		async truncateAll() {
			const { rows } = await client.query<{ tablename: string }>(
				"SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
			);
			if (rows.length === 0) return;
			await client.query(
				`TRUNCATE TABLE ${rows.map((row) => `"${row.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`,
			);
		},
		end: () => client.end(),
	};
}
