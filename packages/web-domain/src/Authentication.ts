import { HttpApiError, HttpApiMiddleware } from "@effect/platform";
import { RpcMiddleware } from "@effect/rpc";
import { Context, Schema } from "effect";

import { InternalError } from "./Errors";

export class CurrentUser extends Context.Tag("CurrentUser")<
	CurrentUser,
	{ id: string; email: string; activeOrgId: string }
>() {}

export class HttpAuthMiddleware extends HttpApiMiddleware.Tag<HttpAuthMiddleware>()(
	"HttpAuthMiddleware",
	{
		provides: CurrentUser,
		failure: Schema.Union(
			HttpApiError.Unauthorized,
			HttpApiError.InternalServerError,
		),
	},
) {}

export class UnauthenticatedError extends Schema.TaggedError<UnauthenticatedError>()(
	"UnauthenticatedError",
	{},
) {}

export class RpcAuthMiddleware extends RpcMiddleware.Tag<RpcAuthMiddleware>()(
	"RpcAuthMiddleware",
	{
		provides: CurrentUser,
		failure: Schema.Union(InternalError, UnauthenticatedError),
	},
) {}
