import { db } from "@cap/database";
import { comments, spaceVideos, videos } from "@cap/database/schema";
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
type SpaceVideoRow = typeof spaceVideos.$inferSelect;
type SpaceOrOrgId = SpaceVideoRow["spaceId"];

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

type RollingAnalyticsRange = Exclude<AnalyticsRange, "lifetime">;

const ROLLING_RANGE_CONFIG: Record<
	RollingAnalyticsRange,
	{ hours: number; bucket: "hour" | "day" }
> = {
	"24h": { hours: 24, bucket: "hour" },
	"7d": { hours: 7 * 24, bucket: "day" },
	"30d": { hours: 30 * 24, bucket: "day" },
};

const LIFETIME_FALLBACK_DAYS = 30;

const escapeLiteral = (value: string) => value.replace(/'/g, "''");
const toDateString = (date: Date) => date.toISOString().slice(0, 10);
const toDateTimeString = (date: Date) =>
	date.toISOString().slice(0, 19).replace("T", " ");

const buildPathnameFilter = (spaceVideoIds?: VideoId[]): string => {
	if (!spaceVideoIds || spaceVideoIds.length === 0) {
		return "";
	}
	const pathnames = spaceVideoIds
		.map((id) => `'/s/${escapeLiteral(id)}'`)
		.join(", ");
	return `AND pathname IN (${pathnames})`;
};

const normalizeBucket = (
	input: string | null | undefined,
	bucket: "hour" | "day",
) => {
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

const getLifetimeRangeStart = async (
	orgId: OrgId,
	videoIds?: VideoId[],
): Promise<Date | undefined> => {
	const whereClause = videoIds && videoIds.length > 0
		? and(eq(videos.orgId, orgId), inArray(videos.id, videoIds))
		: eq(videos.orgId, orgId);

	const rows = await db()
		.select({ minCreatedAt: sql<Date>`MIN(${videos.createdAt})` })
		.from(videos)
		.where(whereClause)
		.limit(1);

	const candidate = rows[0]?.minCreatedAt;
	if (!candidate) return undefined;
	return candidate instanceof Date ? candidate : new Date(candidate);
};

const resolveRangeBounds = async (
	range: AnalyticsRange,
	orgId: OrgId,
	videoIds?: VideoId[],
): Promise<{ from: Date; to: Date; bucket: "hour" | "day" }> => {
	const to = new Date();

	if (range === "lifetime") {
		const lifetimeStart = await getLifetimeRangeStart(orgId, videoIds);
		const fallbackFrom = new Date(
			to.getTime() - LIFETIME_FALLBACK_DAYS * 24 * 60 * 60 * 1000,
		);
		const from =
			lifetimeStart && lifetimeStart < to ? lifetimeStart : fallbackFrom;
		return { from, to, bucket: "day" };
	}

	const config = ROLLING_RANGE_CONFIG[range];
	const from = new Date(to.getTime() - config.hours * 60 * 60 * 1000);
	return { from, to, bucket: config.bucket };
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
			const response = res as { data?: unknown[] };
			const data = response.data ?? [];
			return data.filter((item): item is Row =>
				typeof item === "object" && item !== null,
			) as Row[];
		}),
	);

const getSpaceVideoIds = async (
	spaceId: SpaceOrOrgId,
): Promise<VideoId[]> => {
	const rows = await db()
		.select({ videoId: spaceVideos.videoId })
		.from(spaceVideos)
		.where(eq(spaceVideos.spaceId, spaceId));
	return rows.map((row) => row.videoId);
};

export const getOrgAnalyticsData = async (
	orgId: string,
	range: AnalyticsRange,
	spaceId?: string,
	capId?: string,
): Promise<OrgAnalyticsResponse> => {
	const typedOrgId = orgId as OrgId;

	const spaceVideoIds = spaceId
		? await getSpaceVideoIds(spaceId as SpaceOrOrgId)
		: undefined;
	const capVideoIds = capId ? [capId as VideoId] : undefined;
	const videoIds = capVideoIds || spaceVideoIds;

	const { from, to, bucket } = await resolveRangeBounds(
		range,
		typedOrgId,
		videoIds,
	);
	const buckets = buildBuckets(from, to, bucket);

	if (
		(spaceId && spaceVideoIds && spaceVideoIds.length === 0) ||
		(capId && !capVideoIds)
	) {
		let capName: string | undefined;
		if (capId) {
			const capNames = await loadVideoNames([capId]);
			capName = capNames.get(capId);
		}
		return {
			counts: {
				caps: 0,
				views: 0,
				comments: 0,
				reactions: 0,
			},
			chart: buckets.map((bucket) => ({
				bucket,
				caps: 0,
				views: 0,
				comments: 0,
				reactions: 0,
			})),
			breakdowns: {
				countries: [],
				cities: [],
				browsers: [],
				operatingSystems: [],
				devices: [],
				topCaps: [],
			},
			capName,
		};
	}

	const [capsSeries, commentSeries, reactionSeries] = await Promise.all([
		queryVideoSeries(typedOrgId, from, to, bucket, videoIds),
		queryCommentsSeries(
			typedOrgId,
			from,
			to,
			"text",
			bucket,
			videoIds,
		),
		queryCommentsSeries(
			typedOrgId,
			from,
			to,
			"emoji",
			bucket,
			videoIds,
		),
	]);

		const tinybirdData = await runPromise(
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;

			const viewSeries = yield* queryViewSeries(
				tinybird,
				typedOrgId,
				from,
				to,
				bucket,
				videoIds,
			);

			const countries = yield* queryCountries(
				tinybird,
				typedOrgId,
				from,
				to,
				videoIds,
			);

			const cities = yield* queryCities(
				tinybird,
				typedOrgId,
				from,
				to,
				videoIds,
			);

			const browsers = yield* queryBrowsers(
				tinybird,
				typedOrgId,
				from,
				to,
				videoIds,
			);

			const devices = yield* queryDevices(
				tinybird,
				typedOrgId,
				from,
				to,
				videoIds,
			);

			const operatingSystems = yield* queryOperatingSystems(
				tinybird,
				typedOrgId,
				from,
				to,
				videoIds,
			);

			const topCapsRaw = capId
				? []
				: yield* queryTopCaps(tinybird, typedOrgId, from, to, videoIds);

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

	const totalViews = tinybirdData.viewSeries.reduce(
		(sum, row) => sum + row.views,
		0,
	);
	const totalCaps = capsSeries.reduce((sum, row) => sum + row.count, 0);
	const totalComments = commentSeries.reduce((sum, row) => sum + row.count, 0);
	const totalReactions = reactionSeries.reduce(
		(sum, row) => sum + row.count,
		0,
	);

	const chartData = buckets.map((bucket) => ({
		bucket,
		caps: capsSeries.find((row) => row.bucket === bucket)?.count ?? 0,
		views:
			tinybirdData.viewSeries.find((row) => row.bucket === bucket)?.views ?? 0,
		comments: commentSeries.find((row) => row.bucket === bucket)?.count ?? 0,
		reactions: reactionSeries.find((row) => row.bucket === bucket)?.count ?? 0,
	}));

	const videoNames = await loadVideoNames(
		tinybirdData.topCapsRaw.map((cap) => cap.videoId).filter(Boolean),
	);

	let capName: string | undefined;
	if (capId) {
		const capNames = await loadVideoNames([capId]);
		capName = capNames.get(capId);
	}

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
			browsers: normalizeAndAggregate(
				tinybirdData.browsers,
				totalViews,
				(row) => row.name,
				normalizeBrowserName,
			),
			operatingSystems: normalizeAndAggregate(
				tinybirdData.operatingSystems,
				totalViews,
				(row) => row.name,
				normalizeOSName,
			),
			devices: normalizeAndAggregate(
				tinybirdData.devices,
				totalViews,
				(row) => row.name,
				normalizeDeviceName,
			),
			topCaps: tinybirdData.topCapsRaw.map((row) => ({
				id: row.videoId,
				name: videoNames.get(row.videoId) ?? row.videoId,
				views: row.views,
				percentage: totalViews > 0 ? row.views / totalViews : 0,
			})),
		},
		capName,
	};
};

const normalizeOSName = (name: string): string => {
	if (!name || typeof name !== "string") return name || "Unknown";
	const normalized = name.trim();
	if (!normalized) return "Unknown";
	const lower = normalized.toLowerCase();

	if (
		lower.includes("mac") ||
		lower === "macos" ||
		lower === "mac os" ||
		lower === "darwin"
	) {
		return "macOS";
	}
	if (lower.includes("windows") || lower === "win") {
		return "Windows";
	}
	if (lower.includes("linux")) {
		return "Linux";
	}
	if (lower.includes("android")) {
		return "Android";
	}
	if (lower.includes("ios") || lower === "iphone os") {
		return "iOS";
	}
	if (lower.includes("ubuntu")) {
		return "Ubuntu";
	}
	if (lower.includes("fedora")) {
		return "Fedora";
	}

	return normalized;
};

const normalizeDeviceName = (name: string): string => {
	if (!name || typeof name !== "string") return name || "Unknown";
	const normalized = name.trim();
	if (!normalized) return "Unknown";
	const lower = normalized.toLowerCase();

	if (lower === "desktop" || lower === "desktop computer" || lower === "pc") {
		return "Desktop";
	}
	if (lower === "mobile" || lower === "smartphone" || lower === "phone") {
		return "Mobile";
	}
	if (lower === "tablet" || lower === "ipad") {
		return "Tablet";
	}

	return normalized;
};

const normalizeBrowserName = (name: string): string => {
	if (!name || typeof name !== "string") return name || "Unknown";
	const normalized = name.trim();
	if (!normalized) return "Unknown";
	const lower = normalized.toLowerCase();

	if (lower.includes("chrome") && !lower.includes("chromium")) {
		return "Chrome";
	}
	if (lower.includes("firefox")) {
		return "Firefox";
	}
	if (lower.includes("safari")) {
		return "Safari";
	}
	if (lower.includes("edge")) {
		return "Edge";
	}
	if (lower.includes("opera")) {
		return "Opera";
	}
	if (lower.includes("brave")) {
		return "Brave";
	}
	if (lower.includes("internet explorer") || lower === "ie") {
		return "Internet Explorer";
	}

	return normalized;
};

const normalizeAndAggregate = <T extends { name: string; views: number }>(
	rows: T[],
	totalViews: number,
	getName: (row: T) => string,
	normalizeFn: (name: string) => string,
): BreakdownRow[] => {
	const aggregated = new Map<string, number>();

	for (const row of rows) {
		const originalName = getName(row);
		const normalizedName = normalizeFn(originalName);
		const currentViews = aggregated.get(normalizedName) ?? 0;
		aggregated.set(normalizedName, currentViews + row.views);
	}

	return Array.from(aggregated.entries())
		.map(([name, views]) => ({
			name,
			views,
			percentage: totalViews > 0 ? views / totalViews : 0,
		}))
		.sort((a, b) => b.views - a.views);
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
	spaceVideoIds?: VideoId[],
): Promise<CountSeriesRow[]> => {
	const bucketExpr =
		bucket === "hour"
			? sql<string>`DATE_FORMAT(${videos.createdAt}, '%Y-%m-%dT%H:00:00Z')`
			: sql<string>`DATE_FORMAT(${videos.createdAt}, '%Y-%m-%dT00:00:00Z')`;

	const conditions = [
		eq(videos.orgId, orgId),
		between(videos.createdAt, from, to),
	];

	if (spaceVideoIds && spaceVideoIds.length > 0) {
		conditions.push(inArray(videos.id, spaceVideoIds));
	}

	const rows = await db()
		.select({ bucket: bucketExpr, count: sql<number>`COUNT(*)` })
		.from(videos)
		.where(and(...conditions))
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
	spaceVideoIds?: VideoId[],
): Promise<CountSeriesRow[]> => {
	const column = comments.createdAt;
	const bucketExpr =
		bucket === "hour"
			? sql<string>`DATE_FORMAT(${column}, '%Y-%m-%dT%H:00:00Z')`
			: sql<string>`DATE_FORMAT(${column}, '%Y-%m-%dT00:00:00Z')`;

	const conditions = [
		eq(videos.orgId, orgId),
		eq(comments.type, type),
		between(comments.createdAt, from, to),
	];

	if (spaceVideoIds && spaceVideoIds.length > 0) {
		conditions.push(inArray(videos.id, spaceVideoIds));
	}

	const rows = await db()
		.select({ bucket: bucketExpr, count: sql<number>`COUNT(*)` })
		.from(comments)
		.innerJoin(videos, eq(comments.videoId, videos.id))
		.where(and(...conditions))
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
	spaceVideoIds?: VideoId[],
) => {
	const pathnameFilter = buildPathnameFilter(spaceVideoIds);
	const bucketFormatter =
		bucket === "hour" ? "%Y-%m-%dT%H:00:00Z" : "%Y-%m-%dT00:00:00Z";
	const rawSql = `
		SELECT
			formatDateTime(${bucket === "hour" ? "toStartOfHour" : "toStartOfDay"}(timestamp), '${bucketFormatter}') as bucket,
			uniq(session_id) as views
		FROM analytics_events
		WHERE action = 'page_hit'
			AND tenant_id = '${escapeLiteral(orgId)}'
			AND timestamp BETWEEN toDateTime('${toDateTimeString(from)}') AND toDateTime('${toDateTimeString(to)}')
			${pathnameFilter}
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
			${pathnameFilter}
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
	spaceVideoIds?: VideoId[],
) => {
	const pathnameFilter = buildPathnameFilter(spaceVideoIds);
	const aggregatedSql = `
		SELECT
			country as name,
			uniqMerge(visits) as views
		FROM analytics_pages_mv
		WHERE tenant_id = '${escapeLiteral(orgId)}'
			AND date BETWEEN toDate('${toDateString(from)}') AND toDate('${toDateString(to)}')
			AND country != ''
			${pathnameFilter}
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
			${pathnameFilter}
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
	spaceVideoIds?: VideoId[],
) => {
	const pathnameFilter = buildPathnameFilter(spaceVideoIds);
	const aggregatedSql = `
		SELECT
			country as country,
			city as city,
			uniqMerge(visits) as views
		FROM analytics_pages_mv
		WHERE tenant_id = '${escapeLiteral(orgId)}'
			AND date BETWEEN toDate('${toDateString(from)}') AND toDate('${toDateString(to)}')
			AND city != ''
			${pathnameFilter}
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
			${pathnameFilter}
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
	spaceVideoIds?: VideoId[],
) => {
	const pathnameFilter = buildPathnameFilter(spaceVideoIds);
	const aggregatedSql = `
		SELECT
			browser as name,
			uniq(session_id) as views
		FROM analytics_sessions_mv
		WHERE tenant_id = '${escapeLiteral(orgId)}'
			AND date BETWEEN toDate('${toDateString(from)}') AND toDate('${toDateString(to)}')
			${pathnameFilter}
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
			${pathnameFilter}
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
	spaceVideoIds?: VideoId[],
) => {
	const pathnameFilter = buildPathnameFilter(spaceVideoIds);
	const aggregatedSql = `
		SELECT
			device as name,
			uniq(session_id) as views
		FROM analytics_sessions_mv
		WHERE tenant_id = '${escapeLiteral(orgId)}'
			AND date BETWEEN toDate('${toDateString(from)}') AND toDate('${toDateString(to)}')
			${pathnameFilter}
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
			${pathnameFilter}
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
	spaceVideoIds?: VideoId[],
) => {
	const pathnameFilter = buildPathnameFilter(spaceVideoIds);
	const aggregatedSql = `
		SELECT
			os as name,
			uniq(session_id) as views
		FROM analytics_sessions_mv
		WHERE tenant_id = '${escapeLiteral(orgId)}'
			AND date BETWEEN toDate('${toDateString(from)}') AND toDate('${toDateString(to)}')
			${pathnameFilter}
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
			${pathnameFilter}
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
	spaceVideoIds?: VideoId[],
) => {
	const pathnameFilter = buildPathnameFilter(spaceVideoIds);
	const aggregatedSql = `
		SELECT
			pathname,
			uniqMerge(visits) as views
		FROM analytics_pages_mv
		WHERE tenant_id = '${escapeLiteral(orgId)}'
			AND date BETWEEN toDate('${toDateString(from)}') AND toDate('${toDateString(to)}')
			AND startsWith(pathname, '/s/')
			${pathnameFilter}
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
			${pathnameFilter}
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
