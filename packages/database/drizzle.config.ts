import type { Config } from "drizzle-kit";

export default {
  schema: "./schema.ts",
  dbCredentials: {
    uri: `mysql://${process.env.DB_PLANETSCALE_USERNAME}:${process.env.DB_PLANETSCALE_PASSWORD}@${process.env.DB_PLANETSCALE_HOST}/${process.env.DB_PLANETSCALE_DATABASE}?ssl={"rejectUnauthorized":false}`,
  },
  driver: "mysql2",
} satisfies Config;
