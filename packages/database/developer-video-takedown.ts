import { type SQL, sql } from "drizzle-orm";
import { developerVideos } from "./schema";
import { DEVELOPER_VIDEO_TAKEDOWN_KEY } from "./types/developer-video";

// A takedown is stored in the metadata column so it needs no migration and
// leaves status alone: storage billing groups by status, and the encoding
// workflows rewrite processing, so neither can carry it. The developer's own
// metadata is kept whole inside the marker and written back on restore.
const MARKER_PATH = `$."${DEVELOPER_VIDEO_TAKEDOWN_KEY}"`;
const AT_PATH = `${MARKER_PATH}.at`;
const KEPT_PATH = `${MARKER_PATH}.metadata`;

// Both rewrites run in SQL so the developer's metadata never passes through
// JSON.parse, which would round integers past 2^53 on the way back. A video
// with no metadata goes back to SQL NULL rather than a JSON null.
export function takenDownMetadataSql(now: Date): SQL {
	return sql`JSON_OBJECT(${DEVELOPER_VIDEO_TAKEDOWN_KEY}, JSON_OBJECT('at', ${now.toISOString()}, 'metadata', ${developerVideos.metadata}))`;
}

export function restoredMetadataSql(): SQL {
	return sql`CASE WHEN JSON_TYPE(JSON_EXTRACT(${developerVideos.metadata}, ${KEPT_PATH})) = 'NULL' THEN NULL ELSE JSON_EXTRACT(${developerVideos.metadata}, ${KEPT_PATH}) END`;
}

// For queries that list videos without loading their metadata. It matches
// developerVideoIsTakenDown in the web app. Without the COALESCE a row with no
// metadata reads as NULL, which drizzle passes through without mapWith.
export function developerVideoTakenDownSql(): SQL<boolean> {
	return sql<boolean>`COALESCE((JSON_TYPE(JSON_EXTRACT(${developerVideos.metadata}, ${AT_PATH})) = 'STRING' AND JSON_CONTAINS_PATH(${developerVideos.metadata}, 'one', ${KEPT_PATH})), FALSE)`.mapWith(
		(value) => Number(value) === 1,
	);
}
