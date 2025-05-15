import { drizzle } from "drizzle-orm/planetscale-serverless";
import { Client, Config } from "@planetscale/database";
import { serverEnv } from "@cap/env";

function createDrizzle() {
  const URL = serverEnv().DATABASE_URL;

  let fetchHandler: Promise<Config["fetch"]> | undefined = undefined;

  if (URL.startsWith("mysql://")) {
    fetchHandler = import("@mattrax/mysql-planetscale").then((m) =>
      m.createFetchHandler(URL)
    );
  }

  const connection = new Client({
    url: URL,
    fetch: async (input, init) => {
      return await ((await fetchHandler) || fetch)(input, init);
    },
  });

  return drizzle(connection);
}

let _cached: ReturnType<typeof createDrizzle> | undefined = undefined;

export const db = () => {
  if (!_cached) {
    _cached = createDrizzle();
  }
  return _cached;
};
