import type { Config } from "drizzle-kit";

if (!process.env.DATABASE_URL?.startsWith("mysql://"))
  throw new Error(
    "DATABASE_URL must be a 'mysql://' URI. Drizzle Kit doesn't support the fetch adapter!"
  );

export default {
  schema: "./schema.ts",
  dbCredentials: {
    uri: process.env.DATABASE_URL,
  },
  out: "./migrations",
  driver: "mysql2",
} satisfies Config;
