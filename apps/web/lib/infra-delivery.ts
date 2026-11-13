import { db } from "@cap/database";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
	bigint,
	date,
	int,
	mysqlTable,
	primaryKey,
	timestamp,
	varchar,
} from "drizzle-orm/mysql-core";
import { utcDateKey, utcMonthStart } from "@/lib/infra-usage";

export const developerDeliveryDaily = mysqlTable(
	"developer_delivery_daily",
	{
		appId: varchar("appId", { length: 15 }).notNull(),
		day: date("day", { mode: "string" }).notNull(),
		tier: varchar("tier", { length: 8 }).notNull(),
		seconds: bigint("seconds", { mode: "number" }).notNull(),
		bytes: bigint("bytes", { mode: "number" }).notNull(),
		requests: int("requests").notNull(),
		updatedAt: timestamp("updatedAt").notNull(),
	},
	(table) => [primaryKey({ columns: [table.appId, table.day, table.tier] })],
);

export const DELIVERY_TIERS = [
	"360p",
	"720p",
	"1080p",
	"1440p",
	"2160p",
] as const;

export type DeliveryTier = (typeof DELIVERY_TIERS)[number];

export type DeliveredUsage = {
	seconds: number;
	secondsByTier: Record<DeliveryTier, number>;
};

export type DeliveryJson = {
	minutes: number;
	minutesByTier: Record<DeliveryTier, number>;
	measured: true;
	billed: false;
};

const isDeliveryTier = (tier: string): tier is DeliveryTier =>
	DELIVERY_TIERS.some((known) => known === tier);

const emptyTiers = (): Record<DeliveryTier, number> => ({
	"360p": 0,
	"720p": 0,
	"1080p": 0,
	"1440p": 0,
	"2160p": 0,
});

export function deliveryPeriod(now: Date) {
	const start = utcMonthStart(now);
	const end = new Date(
		Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
	);
	return { start, startDay: utcDateKey(start), endDay: utcDateKey(end) };
}

export function isMissingTableError(error: unknown) {
	for (
		let current: unknown = error, depth = 0;
		current && typeof current === "object" && depth < 5;
		current = (current as { cause?: unknown }).cause, depth++
	) {
		const { code, errno } = current as { code?: unknown; errno?: unknown };
		if (code === "ER_NO_SUCH_TABLE" || errno === 1146) return true;
	}
	return false;
}

export function sumDeliveryRows(
	rows: readonly { tier: string; seconds: unknown }[],
): DeliveredUsage | null {
	const secondsByTier = emptyTiers();
	let seconds = 0;
	let measured = false;
	for (const row of rows) {
		if (!isDeliveryTier(row.tier)) continue;
		const value = Math.max(0, Number(row.seconds) || 0);
		secondsByTier[row.tier] += value;
		seconds += value;
		measured = true;
	}
	return measured ? { seconds, secondsByTier } : null;
}

export async function getDeliveredUsage(
	appId: string,
	now: Date = new Date(),
): Promise<DeliveredUsage | null> {
	const { startDay, endDay } = deliveryPeriod(now);
	try {
		const rows = await db()
			.select({
				tier: developerDeliveryDaily.tier,
				seconds: sql<string>`sum(${developerDeliveryDaily.seconds})`,
			})
			.from(developerDeliveryDaily)
			.where(
				and(
					eq(developerDeliveryDaily.appId, appId),
					gte(developerDeliveryDaily.day, startDay),
					lt(developerDeliveryDaily.day, endDay),
				),
			)
			.groupBy(developerDeliveryDaily.tier);
		return sumDeliveryRows(rows);
	} catch (error) {
		if (isMissingTableError(error)) return null;
		throw error;
	}
}

const toMinutes = (seconds: number) => Math.round((seconds / 60) * 1000) / 1000;

export function deliveryJson(
	usage: DeliveredUsage | null,
): DeliveryJson | null {
	if (!usage) return null;
	const minutesByTier = emptyTiers();
	for (const tier of DELIVERY_TIERS) {
		minutesByTier[tier] = toMinutes(usage.secondsByTier[tier]);
	}
	return {
		minutes: toMinutes(usage.seconds),
		minutesByTier,
		measured: true,
		billed: false,
	};
}
