import { videos } from "@cap/database/schema";
import { type SQL, sql } from "drizzle-orm";

export const videoMetadataObject = (): SQL =>
	sql`IF(JSON_TYPE(${videos.metadata}) = 'OBJECT', ${videos.metadata}, JSON_OBJECT())`;
