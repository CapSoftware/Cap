import { db } from "@cap/database";
import {
	developerCreditTransactions,
	developerVideos,
} from "@cap/database/schema";
import { and, asc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { type AnyMySqlColumn, alias } from "drizzle-orm/mysql-core";

export const FIRST_MONTH_TRANSACTION_TYPE = "video_create" as const;
export const FIRST_MONTH_REFERENCE_TYPE = "developer_video" as const;

type Reader = Pick<ReturnType<typeof db>, "select">;

const firstMonthChargeOf = (
	video: { id: AnyMySqlColumn },
	row: {
		type: AnyMySqlColumn;
		referenceType: AnyMySqlColumn;
		referenceId: AnyMySqlColumn;
		metadata: AnyMySqlColumn;
	},
) =>
	and(
		eq(row.type, FIRST_MONTH_TRANSACTION_TYPE),
		eq(row.referenceType, FIRST_MONTH_REFERENCE_TYPE),
		eq(row.referenceId, video.id),
		sql`JSON_EXTRACT(${row.metadata}, '$.paidUntil') IS NOT NULL`,
	);

export async function firstMonthChargesBegan(
	executor: Reader = db(),
): Promise<Date | null> {
	const charge = alias(developerCreditTransactions, "first_month_charge");
	const settled = alias(developerVideos, "settled_video");
	const chargedAt = (video: { id: AnyMySqlColumn }) =>
		sql`(${executor
			.select({ createdAt: charge.createdAt })
			.from(charge)
			.where(firstMonthChargeOf(video, charge))
			.limit(1)})`;
	const earliestPaidUntil = executor
		.select({ storagePaidUntil: settled.storagePaidUntil })
		.from(settled)
		.where(
			and(
				isNotNull(settled.storagePaidUntil),
				sql`${chargedAt(settled)} IS NOT NULL`,
			),
		)
		.orderBy(asc(settled.storagePaidUntil))
		.limit(1);
	const [first] = await executor
		.select({
			createdAt: sql<Date | null>`MIN(${chargedAt(developerVideos)})`.mapWith(
				charge.createdAt,
			),
		})
		.from(developerVideos)
		.where(
			and(
				gte(developerVideos.storagePaidUntil, sql`(${earliestPaidUntil})`),
				lte(
					developerVideos.storagePaidUntil,
					sql`(${earliestPaidUntil}) + INTERVAL 1 DAY`,
				),
			),
		);
	const began = first?.createdAt;
	return began instanceof Date && !Number.isNaN(began.getTime()) ? began : null;
}
