import { db } from "@cap/database";
import { sql } from "drizzle-orm";
import { MICRO_CREDITS_PER_DOLLAR } from "@/lib/developer-pricing";
import { INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES } from "@/lib/infra-pricing";
import type { InfraDbExecutor } from "@/lib/infra-standing";

export const DELIVERY_AUDIO_TIER = "audio";

export const DELIVERY_MICRO_CREDITS_PER_1000_MINUTES = Math.round(
	INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES * MICRO_CREDITS_PER_DOLLAR,
);

export type DeliveredDay = {
	appId: string;
	day: string;
	seconds: number;
	secondsByTier: Record<string, number>;
	final: boolean;
};

export type DeliveryRollupRow = {
	appId: unknown;
	day: unknown;
	tier: unknown;
	seconds: unknown;
	final: unknown;
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MISSING_TABLE_OR_COLUMN = new Set([1146, 1054]);
const MISSING_TABLE_OR_COLUMN_CODES = new Set([
	"ER_NO_SUCH_TABLE",
	"ER_BAD_FIELD_ERROR",
]);

export function deliveryMicroCredits(seconds: number) {
	if (!Number.isFinite(seconds) || seconds <= 0) return 0;
	return Math.floor(
		(seconds * DELIVERY_MICRO_CREDITS_PER_1000_MINUTES) / (1000 * 60),
	);
}

export function isRollupNotReadyError(error: unknown) {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current; depth++) {
		const { errno, code, cause } = current as {
			errno?: unknown;
			code?: unknown;
			cause?: unknown;
		};
		if (typeof errno === "number" && MISSING_TABLE_OR_COLUMN.has(errno)) {
			return true;
		}
		if (typeof code === "string" && MISSING_TABLE_OR_COLUMN_CODES.has(code)) {
			return true;
		}
		current = cause;
	}
	return false;
}

const isFinalFlag = (value: unknown) =>
	value === true || value === 1 || value === "1";

export function groupDeliveredDays(rows: readonly DeliveryRollupRow[]) {
	const days = new Map<string, DeliveredDay>();
	for (const row of rows) {
		const appId = typeof row.appId === "string" ? row.appId : null;
		const day = typeof row.day === "string" ? row.day : null;
		const tier = typeof row.tier === "string" ? row.tier : null;
		if (!appId || !day || !DAY_PATTERN.test(day) || !tier) continue;
		const key = `${appId}:${day}`;
		const entry = days.get(key) ?? {
			appId,
			day,
			seconds: 0,
			secondsByTier: {},
			final: true,
		};
		days.set(key, entry);
		if (!isFinalFlag(row.final)) {
			entry.final = false;
			continue;
		}
		const seconds = Number(row.seconds);
		if (
			tier !== DELIVERY_AUDIO_TIER &&
			Number.isFinite(seconds) &&
			seconds > 0
		) {
			entry.secondsByTier[tier] = (entry.secondsByTier[tier] ?? 0) + seconds;
			entry.seconds += seconds;
		}
	}
	return [...days.values()].map((entry) =>
		entry.final ? entry : { ...entry, seconds: 0, secondsByTier: {} },
	);
}

export async function readDeliveredDays(
	{ from, to }: { from: string; to: string },
	executor: Pick<InfraDbExecutor, "execute"> = db(),
): Promise<DeliveredDay[] | null> {
	try {
		const result = await executor.execute(
			sql`select appId, DATE_FORMAT(day, '%Y-%m-%d') as day, tier, seconds, final from developer_delivery_daily where day >= ${from} and day <= ${to}`,
		);
		const rows = (Array.isArray(result) ? result[0] : result) as unknown;
		return groupDeliveredDays(
			Array.isArray(rows) ? (rows as DeliveryRollupRow[]) : [],
		);
	} catch (error) {
		if (isRollupNotReadyError(error)) return null;
		throw error;
	}
}
