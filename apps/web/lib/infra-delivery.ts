import { db } from "@cap/database";
import { developerDeliveryDaily } from "@cap/database/schema";
import { and, eq, gte, lt, ne, sql } from "drizzle-orm";
import { utcDateKey, utcMonthStart } from "@/lib/infra-usage";

export const DELIVERY_AUDIO_TIER = "audio" as const;

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
	finalThrough: string | null;
};

export type DeliveryJson = {
	minutes: number;
	minutesByTier: Record<DeliveryTier, number>;
	finalThrough: string | null;
};

export type DeliveryRow = {
	tier: string;
	seconds: unknown;
	finalThrough: unknown;
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

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function deliveryPeriod(now: Date) {
	const start = utcMonthStart(now);
	const end = new Date(
		Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
	);
	return { start, startDay: utcDateKey(start), endDay: utcDateKey(end) };
}

const NOT_READY_ERRORS = new Set<unknown>([
	"ER_NO_SUCH_TABLE",
	"ER_BAD_FIELD_ERROR",
	1146,
	1054,
]);

export function isDeliveryNotReadyError(error: unknown) {
	for (
		let current: unknown = error, depth = 0;
		current && typeof current === "object" && depth < 5;
		current = (current as { cause?: unknown }).cause, depth++
	) {
		const { code, errno } = current as { code?: unknown; errno?: unknown };
		if (NOT_READY_ERRORS.has(code) || NOT_READY_ERRORS.has(errno)) return true;
	}
	return false;
}

export function sumDeliveryRows(
	rows: readonly DeliveryRow[],
): DeliveredUsage | null {
	const secondsByTier = emptyTiers();
	let seconds = 0;
	let measured = false;
	let finalThrough: string | null = null;
	for (const row of rows) {
		if (!isDeliveryTier(row.tier)) continue;
		const value = Math.max(0, Number(row.seconds) || 0);
		secondsByTier[row.tier] += value;
		seconds += value;
		measured = true;
		const day = typeof row.finalThrough === "string" ? row.finalThrough : null;
		if (day && DAY_KEY.test(day) && (!finalThrough || day > finalThrough)) {
			finalThrough = day;
		}
	}
	return measured ? { seconds, secondsByTier, finalThrough } : null;
}

export async function getDeliveredUsage(
	appId: string,
	now: Date = new Date(),
): Promise<DeliveredUsage | null> {
	const { startDay, endDay } = deliveryPeriod(now);
	const table = developerDeliveryDaily;
	try {
		const rows = await db()
			.select({
				tier: table.tier,
				seconds: sql<string>`sum(${table.seconds})`,
				finalThrough: sql<
					string | null
				>`date_format(max(case when ${table.final} then ${table.day} end), '%Y-%m-%d')`,
			})
			.from(table)
			.where(
				and(
					eq(table.appId, appId),
					gte(table.day, startDay),
					lt(table.day, endDay),
					ne(table.tier, DELIVERY_AUDIO_TIER),
				),
			)
			.groupBy(table.tier);
		return sumDeliveryRows(rows);
	} catch (error) {
		if (isDeliveryNotReadyError(error)) return null;
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
		finalThrough: usage.finalThrough,
	};
}
