import type { Config } from "drizzle-kit";
import "dotenv/config";

export default {
  schema: "./schema.ts",
  dbCredentials: {
    uri: process.env['DB_MYSQL_MIGRATION_URL']!
  },
  driver: "mysql2",
} satisfies Config;