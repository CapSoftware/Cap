import { users } from "@cap/database/schema";
import { type SQL, sql } from "drizzle-orm";

// `users.preferences` defaults to the JSON literal `null`, not SQL NULL, so
// `COALESCE(preferences, JSON_OBJECT())` keeps `null` and `JSON_SET` on it
// returns `null`: the write silently stores nothing. Every partial update
// must start from this object instead.
export const userPreferencesObject = (): SQL =>
	sql`IF(JSON_TYPE(${users.preferences}) = 'OBJECT', ${users.preferences}, JSON_OBJECT())`;
