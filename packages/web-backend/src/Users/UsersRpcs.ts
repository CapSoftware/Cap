import { User } from "@cap/web-domain";
import { Effect } from "effect";

export const UsersRpcsLive = User.UserRpcs.toLayer(
	Effect.gen(function* () {
		return {};
	}),
);
