import { jsonbGet, jsonbSet, jsonbText } from "@cap/database/json";
import { videos } from "@cap/database/schema";
import { type SQL, sql } from "drizzle-orm";

export function setGeneratedAiContent(
	metadata: SQL,
	field: "summary" | "chapters",
	value: string | { title: string; start: number }[],
) {
	const editedField = `${field}ManuallyEdited`;
	// Empty values are deliberate removals. clearAiMetadata in edit-video.ts
	// deletes the keys on media replacement, allowing regeneration despite old flags.
	return sql`CASE
		WHEN ${jsonbText(videos.metadata, [editedField])} = 'true'
		AND ${jsonbGet(videos.metadata, [field])} IS NOT NULL
		THEN ${metadata}
		ELSE ${jsonbSet(jsonbSet(metadata, [field], value), [editedField], false)}
	END`;
}
