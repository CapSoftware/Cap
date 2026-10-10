import { users } from "@cap/database/schema";
import { sql } from "drizzle-orm";

// Rows created without preferences can hold a JSON null, which JSON_SET and
// JSON_REMOVE leave untouched, so anything but an object starts over.
export const storedUserPreferences = sql`IF(JSON_TYPE(${users.preferences}) = 'OBJECT', ${users.preferences}, JSON_OBJECT())`;
