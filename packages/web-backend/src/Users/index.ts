import { Effect } from "effect";
import { Database } from "../Database";

export class Users extends Effect.Service<Users>()("Users", {
	effect: Effect.gen(function* () {
		const db = yield* Database;

		return {};
	}),
}) {}
