import { db } from "@cap/database";
import { comments, videos } from "@cap/database/schema";
import { Tinybird } from "@cap/web-backend";
import { and, between, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import { runPromise } from "@/lib/server";

import type {
	AnalyticsRange,
	BreakdownRow,
	OrgAnalyticsResponse,
} from "./types";

type VideoRow = typeof videos.$inferSelect;
type OrgId = VideoRow["orgId"];
type VideoId = VideoRow["id"];

type CountSeriesRow = { bucket: string; count: number };
type ViewSeriesRow = { bucket: string; views: number };
type BreakdownSourceRow = { name: string; views: number; subtitle?: string };
type TopCapRow = { videoId: string; views: number };

type TinybirdAnalyticsData = {
	viewSeries: ViewSeriesRow[];
	countries: BreakdownSourceRow[];
	cities: BreakdownSourceRow[];
	browsers: BreakdownSourceRow[];
	devices: BreakdownSourceRow[];
	operatingSystems: BreakdownSourceRow[];
	topCapsRaw: TopCapRow[];
};

const RANGE_CONFIG: Record<AnalyticsRange, { hours: number; bucket: "hour" | "day" }> = {
	"24h": { hours: 24, bucket: "hour" },
	"7d": { hours: 7 * 24, bucket: "day" },
	"30d": { hours: 30 * 24, bucket: "day" },
};

const escapeLiteral = (value: string) => value.replace(/'/g, "''");
const toDateString = (date: Date) => date.toISOString().slice(0, 10);
const toDateTimeString = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");

const normalizeBucket = (input: string | null | undefined, bucket: "hour" | "day") => {
	if (!input) return undefined;
	if (input.endsWith("Z")) return input;
	if (bucket === "day" && input.length === 10) return `${input}T00:00:00Z`;
	return `${input.replace(" ", "T")}Z`;
};

const formatBucketTimestamp = (value: Date) =>
	// Strip milliseconds so we can string-compare with MySQL/Tinybird buckets
	`${value.toISOString().slice(0, 19)}Z`;

const buildBuckets = (from: Date, to: Date, bucket: "hour" | "day") => {
	const size = bucket === "hour" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
	const buckets: string[] = [];
	const start = Math.floor(from.getTime() / size) * size;
	const end = Math.floor(to.getTime() / size) * size;
	for (let ts = start; ts <= end; ts += size) {
		buckets.push(formatBucketTimestamp(new Date(ts)));
	}
	return buckets;
};

const fallbackIfEmpty = <Row>(
	primary: Effect.Effect<Row[], never, never>,
	fallback?: Effect.Effect<Row[], never, never>,
) =>
	fallback
		? primary.pipe(
			Effect.flatMap((rows) =>
				rows.length > 0 ? Effect.succeed(rows) : fallback,
			),
		)
		: primary;

const withTinybirdFallback = <Row>(
	effect: Effect.Effect<unknown, unknown, never>,
) =>
	effect.pipe(
		Effect.catchAll((e) => {
			console.error("tinybird query error", e);
			return Effect.succeed<{ data: Row[] }>({ data: [] as Row[] });
		}),
		Effect.map((res) => {
			console.log("tinybird raw response", JSON.stringify(res, null, 2));
			const response = res as { data: unknown[] };
			const data = response.data ?? [];
			console.log("tinybird data array", JSON.stringify(data, null, 2));
			const filtered = data.filter((item): item is Row => {
				const isObject = typeof item === "object" && item !== null;
				if (!isObject) {
					console.log("filtered out non-object item", typeof item, item);
				}
				return isObject;
			}) as Row[];
			console.log("tinybird filtered rows", JSON.stringify(filtered, null, 2));
			return filtered;
		}),
	);

export const getOrgAnalyticsData = async (
	orgId: string,
	range: AnalyticsRange,
): Promise<OrgAnalyticsResponse> => {
	const rangeConfig = RANGE_CONFIG[range];
	const to = new Date();
	const from = new Date(to.getTime() - rangeConfig.hours * 60 * 60 * 1000);
	const buckets = buildBuckets(from, to, rangeConfig.bucket);
	const typedOrgId = orgId as OrgId;

	const [capsSeries, commentSeries, reactionSeries] = await Promise.all([
		queryVideoSeries(typedOrgId, from, to, rangeConfig.bucket),
		queryCommentsSeries(typedOrgId, from, to, "text", rangeConfig.bucket),
		queryCommentsSeries(typedOrgId, from, to, "emoji", rangeConfig.bucket),
	]);

	const tinybirdData = await runPromise(
		Effect.gen(function* () {
			const tinybird = yield* Tinybird;
			console.log("getOrgAnalyticsData - orgId:", orgId, "range:", range);
			console.log("getOrgAnalyticsData - from:", from.toISOString(), "to:", to.toISOString());
			
			const viewSeries = yield* queryViewSeries(
				tinybird,
				typedOrgId,
				from,
				to,
				rangeConfig.bucket,
			);
			console.log("getOrgAnalyticsData - viewSeries:", JSON.stringify(viewSeries, null, 2));
			
			const countries = yield* queryCountries(tinybird, typedOrgId, from, to);
			console.log("getOrgAnalyticsData - countries:", JSON.stringify(countries, null, 2));
			
			const cities = yield* queryCities(tinybird, typedOrgId, from, to);
			console.log("getOrgAnalyticsData - cities:", JSON.stringify(cities, null, 2));
			
			const browsers = yield* queryBrowsers(tinybird, typedOrgId, from, to);
			console.log("getOrgAnalyticsData - browsers:", JSON.stringify(browsers, null, 2));
			
			const devices = yield* queryDevices(tinybird, typedOrgId, from, to);
			console.log("getOrgAnalyticsData - devices:", JSON.stringify(devices, null, 2));
			
			const operatingSystems = yield* queryOperatingSystems(
				tinybird,
				typedOrgId,
				from,
				to,
			);
			console.log("getOrgAnalyticsData - operatingSystems:", JSON.stringify(operatingSystems, null, 2));
			
			const topCapsRaw = yield* queryTopCaps(tinybird, typedOrgId, from, to);
			console.log("getOrgAnalyticsData - topCapsRaw:", JSON.stringify(topCapsRaw, null, 2));
			
			return {
				viewSeries,
				countries,
				cities,
				browsers,
				devices,
				operatingSystems,
				topCapsRaw,
			} satisfies TinybirdAnalyticsData;
		}),
	);

	const totalViews = tinybirdData.viewSeries.reduce((sum, row) => sum + row.views, 0);
	const totalCaps = capsSeries.reduce((sum, row) => sum + row.count, 0);
	const totalComments = commentSeries.reduce((sum, row) => sum + row.count, 0);
	const totalReactions = reactionSeries.reduce((sum, row) => sum + row.count, 0);

	const chartData = buckets.map((bucket) => ({
		bucket,
		caps: capsSeries.find((row) => row.bucket === bucket)?.count ?? 0,
		views: tinybirdData.viewSeries.find((row) => row.bucket === bucket)?.views ?? 0,
		comments: commentSeries.find((row) => row.bucket === bucket)?.count ?? 0,
		reactions: reactionSeries.find((row) => row.bucket === bucket)?.count ?? 0,
	}));

	const videoNames = await loadVideoNames(
		tinybirdData.topCapsRaw.map((cap) => cap.videoId).filter(Boolean),
	);

	return {
		counts: {
			caps: totalCaps,
			views: totalViews,
			comments: totalComments,
			reactions: totalReactions,
		},
		chart: chartData,
		breakdowns: {
			countries: formatBreakdown(
				tinybirdData.countries,
				totalViews,
				(row) => row.name,
			),
			cities: formatBreakdown(
				tinybirdData.cities,
				totalViews,
				(row) => row.name,
			),
			browsers: formatBreakdown(
				tinybirdData.browsers,
				totalViews,
				(row) => row.name,
			),
			operatingSystems: formatBreakdown(
				tinybirdData.operatingSystems,
				totalViews,
				(row) => row.name,
			),
			devices: formatBreakdown(
				tinybirdData.devices,
				totalViews,
				(row) => row.name,
			),
			topCaps: tinybirdData.topCapsRaw.map((row) => ({
				id: row.videoId,
				name: videoNames.get(row.videoId) ?? row.videoId,
				views: row.views,
				percentage: totalViews > 0 ? row.views / totalViews : 0,
			})),
		},
	};
};

const formatBreakdown = <T extends { name: string; views: number }>(
	rows: T[],
	totalViews: number,
	getName: (row: T) => string,
): BreakdownRow[] =>
	rows.map((row) => ({
		name: getName(row),
		views: row.views,
		percentage: totalViews > 0 ? row.views / totalViews : 0,
	}));

const loadVideoNames = async (videoIds: ReadonlyArray<string>) => {
	if (videoIds.length === 0) return new Map<string, string>();
	const typedVideoIds = videoIds.map((id) => id as VideoId);
	const records = await db()
		.select({ id: videos.id, name: videos.name })
		.from(videos)
		.where(inArray(videos.id, typedVideoIds));
	return new Map(records.map((record) => [record.id, record.name]));
};

const queryVideoSeries = async (
	orgId: OrgId,
	from: Date,
	to: Date,
	bucket: "hour" | "day",
): Promise<CountSeriesRow[]> => {
	const bucketExpr =
		bucket === "hour"
			? sql<string>`DATE_FORMAT(${videos.createdAt}, '%Y-%m-%dT%H:00:00Z')`
			: sql<string>`DATE_FORMAT(${videos.createdAt}, '%Y-%m-%dT00:00:00Z')`;

	const rows = await db()
		.select({ bucket: bucketExpr, count: sql<number>`COUNT(*)` })
		.from(videos)
		.where(and(eq(videos.orgId, orgId), between(videos.createdAt, from, to)))
		.groupBy(bucketExpr);

	return rows
		.map((row) => ({
			bucket: normalizeBucket(row.bucket, bucket),
			count: Number(row.count) || 0,
		}))
		.filter((row): row is CountSeriesRow => Boolean(row.bucket));
};

const queryCommentsSeries = async (
	orgId: OrgId,
	from: Date,
	to: Date,
	type: "text" | "emoji",
	bucket: "hour" | "day",
): Promise<CountSeriesRow[]> => {
	const column = comments.createdAt;
	const bucketExpr =
		bucket === "hour"
			? sql<string>`DATE_FORMAT(${column}, '%Y-%m-%dT%H:00:00Z')`
			: sql<string>`DATE_FORMAT(${column}, '%Y-%m-%dT00:00:00Z')`;

	const rows = await db()
		.select({ bucket: bucketExpr, count: sql<number>`COUNT(*)` })
		.from(comments)
		.innerJoin(videos, eq(comments.videoId, videos.id))
		.where(
			and(
				eq(videos.orgId, orgId),
				eq(comments.type, type),
				between(comments.createdAt, from, to),
			),
		)
		.groupBy(bucketExpr);

	return rows
		.map((row) => ({
			bucket: normalizeBucket(row.bucket, bucket),
			count: Number(row.count) || 0,
		}))
		.filter((row): row is CountSeriesRow => Boolean(row.bucket));
};

const queryViewSeries = (
	tinybird: Tinybird,
	orgId: OrgId,
	from: Date,
	to: Date,
	bucket: "hour" | "day",
) => {
	const bucketFormatter = bucket === "hour" ? "%Y-%m-%dT%H:00:00Z" : "%Y-%m-%dT00:00:00Z";
	const rawSql = `
		SELECT
			formatDateTime(${bucket === "hour" ? "toStartOfHour" : "toStartOfDay"}(timestamp), '${bucketFormatter}') as bucket,
			uniq(session_id) as views
		FROM analytics_events
		WHERE action = 'page_hit'
			AND tenant_id = '${escapeLiteral(orgId)}'
			AND timestamp BETWEEN toDateTime('${toDateTimeString(from)}') AND toDateTime('${toDateTimeString(to)}')
		GROUP BY bucket
		ORDER BY bucket
	`;

	const aggregatedSql = `
		SELECT
			formatDateTime(date, '${bucketFormatter}') as bucket,
			uniqMerge(visits) as views
		FROM analytics_pages_mv
		WHERE tenant_id = '${escapeLiteral(orgId)}'
			AND date BETWEEN toDate('${toDateString(from)}') AND toDate('${toDateString(to)}')
		GROUP BY bucket
		ORDER BY bucket
	`;

	type Row = { bucket: string; views: number };
	const rawEffect = withTinybirdFallback<Row>(tinybird.querySql<Row>(rawSql));
	const effect =
		bucket === "hour"
			? rawEffect
			: fallbackIfEmpty(
				withTinybirdFallback<Row>(tinybird.querySql<Row>(aggregatedSql)),
				rawEffect,
			);

	return effect.pipe(
		Effect.map((rows) =>
			rows.map((row) => ({
				bucket: row.bucket,
				views: Number(row.views) || 0,
			})),
		),
	);
};

const queryCountries = (
	tinybird: Tinybird,
	orgId: OrgId,
	from: Date,
	to: Date,
) => {
	const aggregatedSql = `
		SELECT
			country as name,
			uniqMerge(visits) as views
		FROM analytics_pages_mv
		WHERE tenant_id = '${escapeLiteral(orgId)}'
			AND date BETWEEN toDate('${toDateString(from)}') AND toDate('${toDateString(to)}')
			AND country != ''
		GROUP BY name
		ORDER BY views DESC
		LIMIT 10
	`;

	const rawSql = `
		SELECT
			coalesce(nullIf(country, ''), '') as name,
			uniq(session_id) as views
		FROM analytics_events
		WHERE action = 'page_hit'
			AND tenant_id = '${escapeLiteral(orgId)}'
			AND timestamp BETWEEN toDateTime('${toDateTimeString(from)}') AND toDateTime('${toDateTimeString(to)}')
			AND country != ''
		GROUP BY name
		ORDER BY views DESC
		LIMIT 10
	`;

	type Row = { name: string; views: number };
	return fallbackIfEmpty(
		withTinybirdFallback<Row>(tinybird.querySql<Row>(aggregatedSql)),
		withTinybirdFallback<Row>(tinybird.querySql<Row>(rawSql)),
	).pipe(
		Effect.map((rows) =>
			rows.map((row) => ({
				name: row.name,
				views: Number(row.views) || 0,
			})),
		),
	);
};

const queryCities = (
	tinybird: Tinybird,
	orgId: OrgId,
	from: Date,
	to: Date,
) => {
	const aggregatedSql = `
		SELECT
			country as country,
			city as city,
			uniqMerge(visits) as views
		FROM analytics_pages_mv
		WHERE tenant_id = '${escapeLiteral(orgId)}'
			AND date BETWEEN toDate('${toDateString(from)}') AND toDate('${toDateString(to)}')
			AND city != ''
		GROUP BY country, city
		ORDER BY views DESC
		LIMIT 10
	`;

	const rawSql = `
		SELECT
			coalesce(nullIf(country, ''), '') as country,
			coalesce(nullIf(city, ''), '') as city,
			uniq(session_id) as views
		FROM analytics_events
		WHERE action = 'page_hit'
			AND tenant_id = '${escapeLiteral(orgId)}'
			AND timestamp BETWEEN toDateTime('${toDateTimeString(from)}') AND toDateTime('${toDateTimeString(to)}')
			AND city != ''
		GROUP BY country, city
		ORDER BY views DESC
		LIMIT 10
	`;

	type Row = { country: string; city: string; views: number };
	return fallbackIfEmpty(
		withTinybirdFallback<Row>(tinybird.querySql<Row>(aggregatedSql)),
		withTinybirdFallback<Row>(tinybird.querySql<Row>(rawSql)),
	).pipe(
		Effect.map((rows) =>
			rows.map((row) => ({
				name: row.city,
				subtitle: row.country,
				views: Number(row.views) || 0,
			})),
		),
	);
};

const queryBrowsers = (
	tinybird: Tinybird,
	orgId: OrgId,
	from: Date,
	to: Date,
) => {
	const aggregatedSql = `
		SELECT
			browser as name,
			uniq(session_id) as views
		FROM analytics_sessions_mv
		WHERE tenant_id = '${escapeLiteral(orgId)}'
			AND date BETWEEN toDate('${toDateString(from)}') AND toDate('${toDateString(to)}')
		GROUP BY name
		ORDER BY views DESC
		LIMIT 10
	`;

	const rawSql = `
		SELECT
			coalesce(nullIf(browser, ''), 'unknown') as name,
			uniq(session_id) as views
		FROM analytics_events
		WHERE action = 'page_hit'
			AND tenant_id = '${escapeLiteral(orgId)}'
			AND timestamp BETWEEN toDateTime('${toDateTimeString(from)}') AND toDateTime('${toDateTimeString(to)}')
		GROUP BY name
		ORDER BY views DESC
		LIMIT 10
	`;

	type Row = { name: string; views: number };
	return fallbackIfEmpty(
		withTinybirdFallback<Row>(tinybird.querySql<Row>(aggregatedSql)),
		withTinybirdFallback<Row>(tinybird.querySql<Row>(rawSql)),
	).pipe(
		Effect.map((rows) =>
			rows.map((row) => ({
				name: row.name,
				views: Number(row.views) || 0,
			})),
		),
	);
};

const queryDevices = (
	tinybird: Tinybird,
	orgId: OrgId,
	from: Date,
	to: Date,
) => {
	const aggregatedSql = `
		SELECT
			device as name,
			uniq(session_id) as views
		FROM analytics_sessions_mv
		WHERE tenant_id = '${escapeLiteral(orgId)}'
			AND date BETWEEN toDate('${toDateString(from)}') AND toDate('${toDateString(to)}')
		GROUP BY name
		ORDER BY views DESC
		LIMIT 10
	`;

	const rawSql = `
		SELECT
			coalesce(nullIf(device, ''), 'desktop') as name,
			uniq(session_id) as views
		FROM analytics_events
		WHERE action = 'page_hit'
			AND tenant_id = '${escapeLiteral(orgId)}'
			AND timestamp BETWEEN toDateTime('${toDateTimeString(from)}') AND toDateTime('${toDateTimeString(to)}')
		GROUP BY name
		ORDER BY views DESC
		LIMIT 10
	`;

	type Row = { name: string; views: number };
	return fallbackIfEmpty(
		withTinybirdFallback<Row>(tinybird.querySql<Row>(aggregatedSql)),
		withTinybirdFallback<Row>(tinybird.querySql<Row>(rawSql)),
	).pipe(
		Effect.map((rows) =>
			rows.map((row) => ({
				name: row.name,
				views: Number(row.views) || 0,
			})),
		),
	);
};

const queryOperatingSystems = (
	tinybird: Tinybird,
	orgId: OrgId,
	from: Date,
	to: Date,
) => {
	const aggregatedSql = `
		SELECT
			os as name,
			uniq(session_id) as views
		FROM analytics_sessions_mv
		WHERE tenant_id = '${escapeLiteral(orgId)}'
			AND date BETWEEN toDate('${toDateString(from)}') AND toDate('${toDateString(to)}')
		GROUP BY name
		ORDER BY views DESC
		LIMIT 10
	`;

	const rawSql = `
		SELECT
			coalesce(nullIf(os, ''), 'unknown') as name,
			uniq(session_id) as views
		FROM analytics_events
		WHERE action = 'page_hit'
			AND tenant_id = '${escapeLiteral(orgId)}'
			AND timestamp BETWEEN toDateTime('${toDateTimeString(from)}') AND toDateTime('${toDateTimeString(to)}')
		GROUP BY name
		ORDER BY views DESC
		LIMIT 10
	`;

	type Row = { name: string; views: number };
	return fallbackIfEmpty(
		withTinybirdFallback<Row>(tinybird.querySql<Row>(aggregatedSql)),
		withTinybirdFallback<Row>(tinybird.querySql<Row>(rawSql)),
	).pipe(
		Effect.map((rows) =>
			rows.map((row) => ({
				name: row.name,
				views: Number(row.views) || 0,
			})),
		),
	);
};

const queryTopCaps = (
	tinybird: Tinybird,
	orgId: OrgId,
	from: Date,
	to: Date,
) => {
	const aggregatedSql = `
		SELECT
			pathname,
			uniqMerge(visits) as views
		FROM analytics_pages_mv
		WHERE tenant_id = '${escapeLiteral(orgId)}'
			AND date BETWEEN toDate('${toDateString(from)}') AND toDate('${toDateString(to)}')
			AND startsWith(pathname, '/s/')
		GROUP BY pathname
		ORDER BY views DESC
		LIMIT 10
	`;

	const rawSql = `
		SELECT
			coalesce(pathname, '') as pathname,
			uniq(session_id) as views
		FROM analytics_events
		WHERE action = 'page_hit'
			AND tenant_id = '${escapeLiteral(orgId)}'
			AND timestamp BETWEEN toDateTime('${toDateTimeString(from)}') AND toDateTime('${toDateTimeString(to)}')
		GROUP BY pathname
		HAVING startsWith(pathname, '/s/')
		ORDER BY views DESC
		LIMIT 10
	`;

	type Row = { pathname: string; views: number };
	return fallbackIfEmpty(
		withTinybirdFallback<Row>(tinybird.querySql<Row>(aggregatedSql)),
		withTinybirdFallback<Row>(tinybird.querySql<Row>(rawSql)),
	).pipe(
		Effect.map((rows) =>
			rows
				.map((row) => ({
					videoId: row.pathname?.split("/s/")[1] ?? row.pathname,
					views: Number(row.views) || 0,
				}))
				.filter((row): row is TopCapRow => Boolean(row.videoId)),
		),
	);
};
