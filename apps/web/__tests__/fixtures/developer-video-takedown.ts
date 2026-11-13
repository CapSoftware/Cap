import type { DeveloperVideoStore } from "./developer-video";

// The takedown rewrites metadata in SQL. This applies the same two rewrites
// to the fake's stored row, so a test can take a video down and restore it.
// The SQL itself was run against MySQL 8 when it was written.
export async function withTakedownSql(
	store: DeveloperVideoStore,
	database: Awaited<
		ReturnType<typeof import("./developer-video").createDeveloperVideoDatabase>
	>,
) {
	const { MySqlDialect } = await import("drizzle-orm/mysql-core");
	const { SQL } = await import("drizzle-orm");
	const dialect = new MySqlDialect();

	const evaluate = (value: unknown, current: unknown): unknown => {
		if (!(value instanceof SQL)) return value;
		const query = dialect.sqlToQuery(value);
		if (query.sql.startsWith("JSON_OBJECT(")) {
			const [key, at] = query.params as [string, string];
			return { [key]: { at, metadata: current } };
		}
		if (query.sql.startsWith("CASE WHEN JSON_TYPE(")) {
			const marker = Object.values(
				(current ?? {}) as Record<string, { metadata?: unknown }>,
			)[0];
			return marker?.metadata ?? null;
		}
		throw new Error(`The fake cannot evaluate ${query.sql}`);
	};

	const wrapped = {
		...database,
		update: () => ({
			set: (updates: Record<string, unknown>) => ({
				where: async () => {
					const current = store.video;
					const applied = Object.fromEntries(
						Object.entries(updates).map(([column, value]) => [
							column,
							evaluate(
								value,
								current?.[column as keyof NonNullable<typeof current>],
							),
						]),
					);
					store.updates.push(updates);
					if (current) store.video = { ...current, ...applied };
				},
			}),
		}),
		transaction: async (run: (tx: unknown) => Promise<unknown>) => run(wrapped),
	};
	return wrapped;
}
