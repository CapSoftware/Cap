import { drizzle } from "drizzle-orm/planetscale-serverless";
import { Client, Config } from "@planetscale/database";

const URL = process.env.DATABASE_URL!;

let fetchHandler: Promise<Config["fetch"]> | undefined = undefined;

if (process.env.NODE_ENV === "development" && URL.startsWith("mysql://")) {
  fetchHandler = import("@mattrax/mysql-planetscale").then((m) =>
    m.createFetchHandler(URL)
  );
}

export const connection = new Client({
  url: URL,
  fetch: async (input, init) => {
    return await ((await fetchHandler) || fetch)(input, init);
  },
});

export const db = drizzle(connection);
