import { serverEnv } from "@cap/env";
import type { Config } from "drizzle-kit";

const URL = serverEnv.DATABASE_MIGRATION_URL ?? serverEnv.DATABASE_URL;

if (!URL)
  throw new Error("DATABASE_URL or DATABASE_MIGRATION_URL must be set!");
if (!URL?.startsWith("mysql://"))
  throw new Error(
    "DATABASE_URL must be a 'mysql://' URI. Drizzle Kit doesn't support the fetch adapter!"
  );

export default {
  schema: "./schema.ts",
  dbCredentials: {
    uri: URL,
  },
  out: "./migrations",
  driver: "mysql2",
} satisfies Config;
