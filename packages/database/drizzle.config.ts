import type { Config } from "drizzle-kit";

const URL = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;

if (!URL)
  throw new Error("DATABASE_URL or DATABASE_MIGRATION_URL must be set!");
if (!URL?.startsWith("mysql://"))
  throw new Error(
    "DATABASE_URL must be a 'mysql://' URI. Drizzle Kit doesn't support the fetch adapter!"
  );

export default {
  schema: "./schema.ts",
  out: "./migrations",
  dialect: "mysql",
  dbCredentials: { url: URL },
  casing: "snake_case",
} satisfies Config;
