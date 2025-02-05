import { drizzle } from "drizzle-orm/planetscale-serverless";
import { Client, Config } from "@planetscale/database";
import { NODE_ENV, serverEnv } from "@cap/env";

const URL = serverEnv.DATABASE_URL;

let fetchHandler: Promise<Config["fetch"]> | undefined = undefined;

if (NODE_ENV === "development" && URL.startsWith("mysql://")) {
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
