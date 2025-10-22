// TODO: Move to Effect service

import { serverEnv } from "@cap/env";
import { Dub } from "dub";

export const dub = () =>
	new Dub({
		token: serverEnv().DUB_API_KEY,
	});
