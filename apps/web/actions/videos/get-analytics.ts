"use server";

import { db } from "@inflight/database";
import { videos } from "@inflight/database/schema";
import { Tinybird } from "@inflight/web-backend";
import { Video } from "@inflight/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { runPromise } from "@/lib/server";

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const MIN_RANGE_DAYS = 1;
const MAX_RANGE_DAYS = 90;
const DEFAULT_RANGE_DAYS = MAX_RANGE_DAYS;

const escapeLiteral = (value: string) => value.replace(/'/g, "''");
const formatDate = (date: Date) => date.toISOString().slice(0, 10);
const formatDateTime = (date: Date) =>
	date.toISOString().slice(0, 19).replace("T", " ");
const buildConditions = (clauses: Array<string | undefined>) =>
	clauses.filter((clause): clause is string => Boolean(clause)).join(" AND ");

const normalizeRangeDays = (rangeDays?: number) => {
	if (!Number.isFinite(rangeDays)) return DEFAULT_RANGE_DAYS;
	const normalized = Math.floor(rangeDays as number);
	if (normalized <= 0) return DEFAULT_RANGE_DAYS;
	return Math.max(MIN_RANGE_DAYS, Math.min(normalized, MAX_RANGE_DAYS));
};

interface GetVideoAnalyticsOptions {
	rangeDays?: number;
}

export async function getVideoAnalytics(
	videoId: string,
	options?: GetVideoAnalyticsOptions,
) {
	if (!videoId) throw new Error("Video ID is required");

	const [{ orgId } = { orgId: null }] = await db()
		.select({ orgId: videos.orgId })
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)))
		.limit(1);

	return runPromise(
		Effect.gen(function* () {
			const tinybird = yield* Tinybird;

			const rangeDays = normalizeRangeDays(options?.rangeDays);
			const now = new Date();
			const from = new Date(now.getTime() - rangeDays * DAY_IN_MS);
			const pathname = `/s/${videoId}`;
			const aggregateConditions = [
				orgId ? `tenant_id = '${escapeLiteral(orgId)}'` : undefined,
				`pathname = '${escapeLiteral(pathname)}'`,
				`date BETWEEN toDate('${formatDate(from)}') AND toDate('${formatDate(now)}')`,
			];
			const aggregateSql = `SELECT coalesce(uniqMerge(visits), 0) AS views FROM analytics_pages_mv WHERE ${buildConditions(aggregateConditions)}`;

			const rawConditions = [
				"action = 'page_hit'",
				orgId ? `tenant_id = '${escapeLiteral(orgId)}'` : undefined,
				`pathname = '${escapeLiteral(pathname)}'`,
				`timestamp BETWEEN toDateTime('${formatDateTime(from)}') AND toDateTime('${formatDateTime(now)}')`,
			];
			const rawSql = `SELECT coalesce(uniq(session_id), 0) AS views FROM analytics_events WHERE ${buildConditions(rawConditions)}`;

			const querySql = (sql: string) =>
				tinybird.querySql<{ views: number }>(sql).pipe(
					Effect.catchAll((e) => {
						console.error("tinybird sql error", e);
						return Effect.succeed({ data: [] });
					}),
				);

			const aggregateResult = yield* querySql(aggregateSql);

			const fallbackResult = aggregateResult.data?.length
				? aggregateResult
				: yield* querySql(rawSql);

			const data = fallbackResult?.data ?? [];
			const firstItem = data[0];
			const count =
				typeof firstItem === "number"
					? firstItem
					: typeof firstItem === "object" &&
							firstItem !== null &&
							"views" in firstItem
						? Number(firstItem.views ?? 0)
						: 0;
			return { count: Number.isFinite(count) ? count : 0 };
		}),
	);
}
