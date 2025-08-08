import { Effect } from "effect";
import { UsersRepo } from "./UsersRepo";

export class Users extends Effect.Service<Users>()("Users", {
  effect: Effect.gen(function* () {
    const repo = yield* UsersRepo;

    return {};
  }),
}) {}
