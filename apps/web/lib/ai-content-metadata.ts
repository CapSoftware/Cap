import { videos } from "@cap/database/schema";
import { type SQL, sql } from "drizzle-orm";

export function setGeneratedAiContent(
	metadata: SQL,
	field: "summary" | "chapters",
	value: string | { title: string; start: number }[],
) {
	const path = `$.${field}`;
	const editedPath = `$.${field}ManuallyEdited`;
	return sql`IF(
		JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, ${editedPath})) = 'true'
		AND JSON_CONTAINS_PATH(${videos.metadata}, 'one', ${path}),
		${metadata},
		JSON_SET(${metadata}, ${path}, CAST(${JSON.stringify(value)} AS JSON), ${editedPath}, CAST('false' AS JSON))
	)`;
}
