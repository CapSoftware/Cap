import { Context, Schema } from "effect";
import { HttpApiError, HttpApiMiddleware } from "@effect/platform";
import { DatabaseError } from "./Database";

export class CurrentUser extends Context.Tag("CurrentUser")<
  CurrentUser,
  { id: string; email: string }
>() {}

export class AuthMiddleware extends HttpApiMiddleware.Tag<AuthMiddleware>()(
  "AuthMiddleware",
  {
    provides: CurrentUser,
    failure: Schema.Union(
      HttpApiError.Unauthorized,
      HttpApiError.InternalServerError
    ),
  }
) {}
