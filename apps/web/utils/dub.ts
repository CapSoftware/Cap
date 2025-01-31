import { Dub } from "dub";
import { serverEnv } from "env/server";

export const dub = new Dub({
  token: serverEnv.DUB_API_KEY,
});
