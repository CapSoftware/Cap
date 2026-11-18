import { db } from "@cap/database";
import { organizations, spaceVideos, videos } from "@cap/database/schema";
import type { Space } from "@cap/web-domain";
import { and, asc, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import type { SpaceVideoOrder } from "./space-video-order";

export const spaceVideoPositionSql = sql<
	number | null
>`MIN(${spaceVideos.position})`;

// Unplaced videos (position NULL) sort first, newest first, so anything added
// after a custom order was set shows up at the top instead of hiding on the
// last page. MySQL sorts NULL before numbers in ascending order.
export function spaceVideoOrderBy(
	order: SpaceVideoOrder,
	columns: {
		position: SQL | SQL.Aliased;
		effectiveCreatedAt: typeof videos.effectiveCreatedAt;
		id: typeof videos.id;
	},
): SQL[] {
	if (order === "oldest")
		return [asc(columns.effectiveCreatedAt), asc(columns.id)];
	if (order === "custom")
		return [
			asc(columns.position as SQL),
			desc(columns.effectiveCreatedAt),
			desc(columns.id),
		];
	return [desc(columns.effectiveCreatedAt), desc(columns.id)];
}

type QueryExecutor = Pick<ReturnType<typeof db>, "select">;

export async function getSpaceRootVideoOrder(
	spaceId: Space.SpaceIdOrOrganisationId,
	order: SpaceVideoOrder,
	options: {
		includeScreenshots?: boolean;
		executor?: QueryExecutor;
		limit?: number;
	} = {},
) {
	const query = (options.executor ?? db())
		.select({
			id: videos.id,
			isScreenshot: videos.isScreenshot,
			position: spaceVideoPositionSql,
		})
		.from(spaceVideos)
		.innerJoin(videos, eq(spaceVideos.videoId, videos.id))
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(
			and(
				eq(spaceVideos.spaceId, spaceId),
				isNull(spaceVideos.folderId),
				isNull(organizations.tombstoneAt),
			),
		)
		.groupBy(videos.id, videos.isScreenshot, videos.effectiveCreatedAt)
		.orderBy(
			...spaceVideoOrderBy(order, {
				position: spaceVideoPositionSql,
				effectiveCreatedAt: videos.effectiveCreatedAt,
				id: videos.id,
			}),
		)
		.$dynamic();
	const rows = await (options.limit === undefined
		? query
		: query.limit(options.limit));

	return options.includeScreenshots === false
		? rows.filter((row) => !row.isScreenshot)
		: rows;
}
