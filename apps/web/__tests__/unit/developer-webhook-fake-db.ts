import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { createFakeDatabase } from "./developer-transcript-fake-db";

type Row = Record<string, unknown>;

const dialect = new MySqlDialect();

const isSql = (value: unknown): value is SQL =>
	typeof value === "object" && value !== null && "queryChunks" in value;

const keepsColumn = (value: unknown) =>
	isSql(value) &&
	/^`[^`]+`(\.`[^`]+`)?$/.test(dialect.sqlToQuery(value).sql.trim());

export const webhookEndpointDefaults = (): Row => ({
	events: ["video.ready", "video.errored"],
	enabled: true,
	disabledReason: null,
	lastDeliveryAt: null,
	lastDeliveryStatus: null,
	lastResponseStatus: null,
	lastErrorCode: null,
	consecutiveFailures: 0,
	failingSince: null,
	deletedAt: null,
});

// Adds the two things the endpoint queries use that the shared fake does not
// read: a join to the app table, and an update that leaves updatedAt alone.
export function createWebhookFakeDatabase(
	defaults: Map<object, () => Row>,
	options: { joined?: (row: Row) => boolean } = {},
) {
	const fake = createFakeDatabase(defaults);
	const base = fake.db;

	const select = (fields?: Record<string, unknown>) => ({
		from: (table: object) => {
			const state = { joined: false };
			const chain = base.select(fields).from(table);
			const rows = async () => {
				const found = await chain;
				return state.joined && options.joined
					? found.filter(options.joined)
					: found;
			};
			const wrapped = Object.assign(Promise.resolve().then(rows), {
				innerJoin() {
					state.joined = true;
					return wrapped;
				},
				where(condition: SQL | undefined) {
					chain.where(condition);
					return wrapped;
				},
				orderBy() {
					chain.orderBy();
					return wrapped;
				},
				limit(count: number) {
					chain.limit(count);
					return wrapped;
				},
				offset(count: number) {
					chain.offset(count);
					return wrapped;
				},
				for() {
					return wrapped;
				},
			});
			return wrapped;
		},
	});

	const update = (table: object) => ({
		set: (values: Row) =>
			base
				.update(table)
				.set(
					Object.fromEntries(
						Object.entries(values).map(([key, value]) => [
							key,
							keepsColumn(value) ? undefined : value,
						]),
					),
				),
	});

	const client = { ...base, select, update };
	return {
		...fake,
		db: {
			...client,
			transaction: <T>(run: (tx: typeof client) => Promise<T>) =>
				base.transaction(() => run(client)),
		},
	};
}
