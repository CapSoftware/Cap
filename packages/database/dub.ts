import { Dub } from "dub";
import { serverEnv } from "@cap/env";

export const dub = () =>
  new Dub({
    token: serverEnv().DUB_API_KEY,
  }); 