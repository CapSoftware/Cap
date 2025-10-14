import { RpcGroup } from "@effect/rpc";
import { Schema } from "effect";

import { RpcAuthMiddleware } from "./Authentication.ts";

export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

export class UserRpcs extends RpcGroup.make() {}
