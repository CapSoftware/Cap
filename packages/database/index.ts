import { drizzle } from "drizzle-orm/planetscale-serverless";
import { Client, Config } from "@planetscale/database";

const URL = process.env.DATABASE_URL!;

let fetchHandler: Config["fetch"] = undefined;

export const connection = new Client({
  url: URL,
  fetch: async (input, init) => {
    if (
      process.env.NEXT_PUBLIC_ENVIRONMENT === "development" &&
      URL.startsWith("mysql://")
    ) {
      fetchHandler = (
        await import("@mattrax/mysql-planetscale")
      ).createFetchHandler(URL);
    }

    return await (fetchHandler || fetch)(input, init);
  },
});

export const db = drizzle(connection);
