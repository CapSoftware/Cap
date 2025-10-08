import { serverEnv } from "@cap/env/server";
import { Dub } from "dub";

export const dub = () =>
	new Dub({
		token: serverEnv().DUB_API_KEY,
	});
