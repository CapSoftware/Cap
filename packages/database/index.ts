import { drizzle } from "drizzle-orm/planetscale-serverless";
import { Client } from "@planetscale/database";

export const connection = new Client({
  url: `mysql://${process.env.DB_PLANETSCALE_USERNAME}:${process.env.DB_PLANETSCALE_PASSWORD}@${process.env.DB_PLANETSCALE_HOST}/${process.env.DB_PLANETSCALE_DATABASE}?ssl={"rejectUnauthorized":false}`,
});

export const db = drizzle(connection);
